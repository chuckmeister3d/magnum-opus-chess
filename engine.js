// Magnum Opus. Copyright (C) 2026 Charles Davison.
// Free software under the GNU General Public License v3 or later; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// engine.js — Stockfish (WASM) running in the browser, one or more Web Workers.
//
// Each worker is an independent Stockfish process speaking UCI. We evaluate a
// position by sending `position fen ...` + `go depth N` and reading the last
// `info ... score ...` line before `bestmove`. Multiple workers run different
// games concurrently — the browser equivalent of the Python multiprocessing
// pool, giving near-linear speedup with the user's core count.

import { Chess } from './vendor/chess.js';

const DBG = true; // set false to silence the MO: diagnostics
function log(...a) { if (DBG) console.log('MO:', ...a); }

class StockfishWorker {
  constructor(scriptUrl) {
    this.scriptUrl = scriptUrl;
    this._buffer = [];
    this._pending = null;
    this._error = null;
    this._errWaiters = [];
    this.ready = false;
    try {
      this.worker = new Worker(scriptUrl);
    } catch (e) {
      // constructing the Worker itself can throw (bad URL, blocked, etc.)
      this._error = `could not create worker (${e.message})`;
      log('worker construction failed for', scriptUrl, e);
      return;
    }
    this.worker.onmessage = (e) => this._onLine(typeof e.data === 'string' ? e.data : e.data?.data);
    // Surface worker load/runtime errors (e.g. WASM failed to instantiate) so
    // init() rejects with a real reason instead of silently timing out.
    this.worker.onerror = (e) => {
      const msg = (e && (e.message || e.filename)) || 'worker error';
      this._error = msg;
      log('worker error from', scriptUrl, '->', msg, e);
      const waiters = this._errWaiters; this._errWaiters = [];
      waiters.forEach((fn) => fn(msg));
    };
    // Some browsers deliver worker script errors as messageerror
    this.worker.onmessageerror = (e) => log('worker messageerror', e);
  }

  _onLine(line) {
    if (typeof line !== 'string') return;
    if (DBG && this._buffer.length < 4) log('engine says:', line.slice(0, 60));
    this._buffer.push(line);
    if (this._pending) this._pending(line);
  }

  _send(cmd) { this.worker.postMessage(cmd); }

  // wait until a line matching `pred` arrives; returns that line
  _await(pred) {
    return new Promise((resolve) => {
      const handler = (line) => {
        if (pred(line)) { this._pending = prev; resolve(line); }
      };
      const prev = this._pending;
      this._pending = handler;
      // also scan already-buffered lines
      for (const l of this._buffer) if (pred(l)) { this._pending = prev; resolve(l); return; }
    });
  }

  // like _await, but rejects after `ms` so a wedged engine surfaces an error
  // instead of hanging the whole page forever.
  _awaitTimed(pred, ms, errMsg) {
    return new Promise((resolve, reject) => {
      if (this._error) { reject(new Error('Stockfish worker error: ' + this._error)); return; }
      let done = false;
      const prev = this._pending;
      const timer = setTimeout(() => {
        if (done) return;
        done = true; this._pending = prev;
        reject(new Error(errMsg || 'engine timed out'));
      }, ms);
      const handler = (line) => {
        if (done) return;
        if (pred(line)) { done = true; clearTimeout(timer); this._pending = prev; resolve(line); }
      };
      this._pending = handler;
      // if the worker errors while we wait, reject immediately with the reason
      this._errWaiters.push((msg) => {
        if (done) return;
        done = true; clearTimeout(timer); this._pending = prev;
        reject(new Error('Stockfish worker error: ' + msg));
      });
      for (const l of this._buffer) {
        if (pred(l)) { done = true; clearTimeout(timer); this._pending = prev; resolve(l); return; }
      }
    });
  }

  async init(timeoutMs = 20000) {
    if (this._error) throw new Error('Stockfish worker error: ' + this._error);
    log('init: sending uci to', this.scriptUrl);
    this._send('uci');
    await this._awaitTimed((l) => l.startsWith('uciok'), timeoutMs,
      'Stockfish did not respond to "uci" (no uciok). The engine failed to start.');
    log('init: got uciok');
    // Do NOT send `setoption name Threads` here. This is the single-threaded
    // WASM/asm.js Stockfish build (no SharedArrayBuffer), and setting Threads
    // wedges it — it never returns `readyok`, which made the whole engine phase
    // time out. It already runs on exactly one thread. (Confirmed in-browser.)
    this._send('setoption name Hash value 32');
    this._send('isready');
    await this._awaitTimed((l) => l.startsWith('readyok'), timeoutMs,
      'Stockfish did not become ready (no readyok).');
    log('init: got readyok — engine ready');
    this.ready = true;
  }

  // Evaluate one FEN at the given depth. Returns {type:'cp'|'mate', value} (White
  // POV), or null. `timeoutMs` guards against a search that never returns a
  // bestmove: we send `stop` and use the deepest score seen so far.
  async evalFen(fen, depth, timeoutMs = 15000) {
    this._buffer = [];
    this._send('ucinewgame');
    this._send(`position fen ${fen}`);
    let lastScore = null;
    // side to move, to convert UCI's stm-relative score to White POV
    const whiteToMove = fen.split(' ')[1] === 'w';

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); this._pending = null; resolve();
      };
      const timer = setTimeout(() => { this._send('stop'); finish(); }, timeoutMs);
      const handler = (line) => {
        if (line.startsWith('info') && line.includes(' score ')) {
          const m = line.match(/score (cp|mate) (-?\d+)/);
          if (m) lastScore = { kind: m[1], val: parseInt(m[2], 10) };
        } else if (line.startsWith('bestmove')) {
          finish();
        }
      };
      this._pending = handler;
      this._send(`go depth ${depth}`);
    });

    if (!lastScore) return null;
    // UCI scores are from side-to-move's POV; flip to White POV
    let value = lastScore.val;
    if (!whiteToMove) value = -value;
    return lastScore.kind === 'mate' ? { type: 'mate', value } : { type: 'cp', value };
  }

  terminate() { if (this.worker) { try { this.worker.terminate(); } catch (e) {} } }
}

// Candidate engine scripts, best first: the WASM build, then the self-contained
// asm.js build (no separate .wasm to fetch/instantiate — more robust when the
// WASM build won't start in a given browser).
export function detectEngineScripts() {
  const wasmSupported = typeof WebAssembly === 'object'
    && WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
  return wasmSupported
    ? ['./vendor/stockfish.wasm.js', './vendor/stockfish.js']
    : ['./vendor/stockfish.js'];
}

// Back-compat: the first (preferred) candidate only.
export async function detectEngineScript() {
  return detectEngineScripts()[0];
}

// Try candidate scripts in order; return the first that actually initialises
// (uci -> uciok -> readyok). Throws with the collected reasons if none work.
export async function pickEngineScript(scripts) {
  const errors = [];
  for (const s of scripts) {
    const w = new StockfishWorker(s);
    try {
      await w.init(10000); // short probe: init is just the uci handshake
      w.terminate();
      log('using engine script', s);
      return s;
    } catch (e) {
      errors.push(`${s}: ${e.message}`);
      log('engine script failed:', s, '->', e.message);
      w.terminate();
    }
  }
  throw new Error('No Stockfish build could start. ' + errors.join(' | '));
}

// Benchmark: seconds per position on THIS machine, at the given depth. All FENs
// are legal (an earlier list included a kingless position, which some Stockfish
// builds never return a bestmove for). `onProgress(done, total)` lets the caller
// show that the benchmark is actually moving.
export async function benchmark(scriptUrl, depth = 10, samplePositions = 4, onProgress = null) {
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',   // opening
    'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', // early
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R b KQkq - 0 6', // middlegame
    '4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1',                // pawn endgame (legal)
  ];
  const sample = [];
  for (let i = 0; i < samplePositions; i++) sample.push(fens[i % fens.length]);
  const w = new StockfishWorker(scriptUrl);
  await w.init();
  const t0 = performance.now();
  for (let i = 0; i < sample.length; i++) {
    await w.evalFen(sample[i], depth);
    if (onProgress) onProgress(i + 1, sample.length);
  }
  const elapsed = (performance.now() - t0) / 1000;
  w.terminate();
  return elapsed / sample.length;
}

// Cheap terminal-position eval, no search (mirrors the Python engine_pool):
// checkmate -> mate for the side that just moved; stalemate / insufficient
// material -> 0.00 (White POV). Returns null if the position is still playable.
function terminalEval(fen) {
  let board;
  try { board = new Chess(fen); } catch { return null; }
  if (board.isCheckmate()) {
    // The side to move is mated, so the side that just moved delivered mate.
    return { type: 'mate', value: board.turn() === 'w' ? -1 : 1 };
  }
  if (board.isStalemate() || board.isInsufficientMaterial()) return { type: 'cp', value: 0 };
  return null;
}

// Evaluate many games in parallel. jobs = [{index, fens}]; returns {index: [evals]}.
// onProgress receives {games, totalGames, positions, totalPositions} after each
// position, so the UI can move smoothly even within a single long game.
export async function evaluateGamesParallel(jobs, scriptUrl, {
  depth = 10, workers = 2, onProgress = null,
} = {}) {
  if (!jobs.length) return {};
  const nWorkers = Math.max(1, Math.min(workers, jobs.length));
  const pool = [];
  for (let i = 0; i < nWorkers; i++) {
    const w = new StockfishWorker(scriptUrl);
    await w.init();
    pool.push(w);
  }

  const results = {};
  const totalGames = jobs.length;
  const totalPositions = jobs.reduce((a, j) => a + j.fens.length, 0);
  let nextJob = 0, doneGames = 0, donePositions = 0;
  const report = () => {
    if (onProgress) onProgress({ games: doneGames, totalGames, positions: donePositions, totalPositions });
  };

  async function runWorker(worker) {
    while (nextJob < jobs.length) {
      const jobIdx = nextJob++;
      const { index, fens } = jobs[jobIdx];
      const evals = [];
      for (const fen of fens) {
        const term = terminalEval(fen);
        evals.push(term !== null ? term : await worker.evalFen(fen, depth));
        donePositions++;
        report();
      }
      results[index] = evals;
      doneGames++;
      report();
    }
  }

  await Promise.all(pool.map(runWorker));
  pool.forEach(w => w.terminate());
  return results;
}
