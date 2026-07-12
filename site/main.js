// Magnum Opus — find your best Lichess games, analysed in your browser.
// Copyright (C) 2026 Charles Davison.
// Free software under the GNU General Public License v3 or later; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// main.js — the site controller. Orchestrates: fetch games -> parse ->
// analyze pre-evaluated ones instantly -> benchmark -> estimate time ->
// (with consent) run browser-Stockfish on the rest -> render the report.

import * as pgn from './pgn.js';
import * as an from './analysis.js';
import * as engine from './engine.js';
import { renderReport } from './render.js';

const PIECES_URL = './assets/pieces.json';
let PIECE_SVG = null;

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

function setStatus(msg) { el('status-line').textContent = msg; }

// --- stepped progress: each stage (download / benchmark / analyse) has its own
// labelled bar. setStep toggles pending|active|done; stepBar/stepStat fill it. ---
const STEP_NUM = { download: '1', benchmark: '2', analyse: '3' };
function setStep(name, state) { // 'pending' | 'active' | 'done'
  const li = el('step-' + name);
  if (!li) return;
  li.classList.remove('active', 'done');
  if (state !== 'pending') li.classList.add(state);
  const dot = li.querySelector('.step-dot');
  if (dot) dot.textContent = state === 'done' ? '✓' : STEP_NUM[name];
}
function stepBar(name, frac) {
  const f = el('fill-' + name);
  if (f) f.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}
function stepStat(name, text) { const s = el('stat-' + name); if (s) s.textContent = text || ''; }
function resetSteps() {
  for (const s of ['download', 'benchmark', 'analyse']) { setStep(s, 'pending'); stepBar(s, 0); stepStat(s, ''); }
}

function humanDuration(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 90) return `${seconds} seconds`;
  const min = seconds / 60;
  if (min < 90) return `${Math.round(min)} minutes`;
  return `${(min / 60).toFixed(1)} hours`;
}

async function loadPieces() {
  if (PIECE_SVG) return PIECE_SVG;
  const resp = await fetch(PIECES_URL);
  PIECE_SVG = await resp.json();
  return PIECE_SVG;
}

// pull the date-range choice from the form
function getDateRange() {
  const mode = document.querySelector('input[name="range"]:checked').value;
  if (mode === 'all') return { since: null, until: null };
  return { since: el('since').value || null, until: el('until').value || null };
}

let engineScript = null;

async function run() {
  const username = el('username').value.trim();
  if (!username) { setStatus('Please enter a Lichess username.'); return; }

  hide('intro');
  hide('report-root');
  resetSteps();
  const ie = el('intro-error'); if (ie) ie.classList.add('hidden');
  show('progress-panel');
  el('run-btn').disabled = true;

  const { since, until } = getDateRange();
  const token = (el('token') && el('token').value.trim()) || null;
  const rangeMode = document.querySelector('input[name="range"]:checked')?.value;
  if (rangeMode === 'custom' && !since && !until) {
    reset('Pick a "From" and/or "To" date for the range, or choose "All time".');
    return;
  }
  let engineWarning = null;

  try {
    // ---- STEP 1: download ----
    setStep('download', 'active');
    setStatus(`Looking up ${username}…`);
    const totalEstimate = await pgn.fetchGameCount(username, token);

    setStatus(`Downloading ${username}'s games from Lichess…`);
    const pgnText = await pgn.fetchGamesPGN(username, {
      since, until, token,
      onProgress: (received, games) => {
        const kb = Math.round(received / 1024);
        // Drive the bar by game count against the account estimate (a date range
        // is a subset of that total), falling back to bytes. Cap below full so the
        // bar never reads "done" while games are still streaming in.
        const byGames = totalEstimate ? games / totalEstimate : 0;
        const byBytes = received / 6_000_000;
        stepBar('download', Math.min(0.97, Math.max(byGames, byBytes)));
        const label = (totalEstimate && !since && !until)
          ? `${games} of ~${totalEstimate} games so far · ${kb} KB`
          : `${games} games so far · ${kb} KB`;
        stepStat('download', label);
      },
    });

    setStatus('Reading games…');
    const games = pgn.parsePGN(pgnText);
    if (!games.length) { reset(`No games found for "${username}" in that range.`); return; }

    // score the pre-evaluated games instantly, collect the rest
    const results = [];
    const needEval = []; // {game, fens}
    for (const g of games) {
      const r = an.analyzeGame(g, username);
      if (r && r.NEEDS_ENGINE_EVAL) needEval.push({ game: g, fens: r.NEEDS_ENGINE_EVAL });
      else if (r) results.push(r);
    }
    stepBar('download', 1);
    stepStat('download', `${games.length} games · ${results.length} pre-analysed · ${needEval.length} to evaluate`);
    setStep('download', 'done');

    // ---- STEPS 2 & 3: only when some games need local evaluation ----
    if (!needEval.length) {
      stepStat('benchmark', 'none needed');
      stepStat('analyse', 'none needed');
    } else {
      // WASM Stockfish is ~100x slower than a native binary, so depth 10 (not the
      // desktop tool's 12) keeps in-browser runs practical. Games Lichess already
      // analysed keep their own deeper stored evals; this only affects the rest.
      const DEPTH = 10;
      try {
        if (!engineScript) engineScript = await engine.pickEngineScript(engine.detectEngineScripts());

        // ---- STEP 2: benchmark + time estimate ----
        setStep('benchmark', 'active');
        setStatus('Benchmarking your device to estimate the time…');
        const secPerPos = await engine.benchmark(engineScript, DEPTH, 4, (i, n) => {
          stepBar('benchmark', i / n);
          stepStat('benchmark', `${i}/${n} test positions`);
        });
        const workers = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
        // newest-first, capped for responsiveness
        needEval.sort((a, b) => (b.game.headers.UTCDate + (b.game.headers.UTCTime || ''))
          .localeCompare(a.game.headers.UTCDate + (a.game.headers.UTCTime || '')));

        const avgPlies = 70;
        const estFull = needEval.length * avgPlies * secPerPos / workers;
        stepBar('benchmark', 1);
        stepStat('benchmark', `~${humanDuration(estFull)} · ${workers} worker${workers > 1 ? 's' : ''}`);
        setStep('benchmark', 'done');

        // ---- confirm before the long part ----
        setStatus('Ready when you are — analysing the games Lichess never evaluated.');
        const proceed = await askConsent(needEval.length, workers, estFull);
        if (proceed.cancelled) { reset(); return; }

        const toEval = needEval.slice(0, proceed.cap);
        if (!toEval.length) {
          stepStat('analyse', 'skipped');
        } else {
          // ---- STEP 3: analyse ----
          setStep('analyse', 'active');
          setStatus(`Analysing ${toEval.length} game${toEval.length > 1 ? 's' : ''} with Stockfish in your browser…`);
          const jobs = toEval.map((x, i) => ({ index: i, fens: x.fens }));
          const evalMap = await engine.evaluateGamesParallel(jobs, engineScript, {
            depth: DEPTH, workers,
            onProgress: (p) => {
              stepBar('analyse', p.totalPositions ? p.positions / p.totalPositions : 0);
              stepStat('analyse', `${p.games}/${p.totalGames} games · ${p.positions}/${p.totalPositions} positions`);
            },
          });

          for (let i = 0; i < toEval.length; i++) {
            const evals = evalMap[i];
            if (!evals) continue;
            const r = an.analyzeGame(toEval[i].game, username, evals);
            if (r && !r.NEEDS_ENGINE_EVAL) { r.evals_from = 'engine'; results.push(r); }
          }
          stepBar('analyse', 1);
          setStep('analyse', 'done');
        }
      } catch (engErr) {
        // Browser engine failed (e.g. it wouldn't start, or every search timed
        // out). Don't lose the whole report — fall back to the games Lichess has
        // already analysed. Only give up if there are none.
        console.error('MO: engine phase failed, falling back to Lichess-analysed games:', engErr);
        hide('consent-panel');
        stepStat('benchmark', 'engine unavailable');
        stepStat('analyse', 'skipped');
        engineWarning = `In-browser Stockfish couldn't run (${engErr.message}). Showing only the games Lichess had already analysed, so these tabs may be sparse. See the browser console (look for "MO:" lines) for details.`;
        if (!results.length) throw engErr;
      }
    }

    if (!results.length) { reset('No games could be analysed.'); return; }

    // ---- build report ----
    setStatus('Building your report…');
    const data = an.rankIntoTabs(results, username, games.length);
    const pieces = await loadPieces();

    hide('progress-panel');
    show('report-root');
    renderReport(data, pieces);
    const warnEl = el('engine-warning');
    if (warnEl) {
      if (engineWarning) { warnEl.textContent = engineWarning; warnEl.classList.remove('hidden'); }
      else warnEl.classList.add('hidden');
    }
    el('run-btn').disabled = false;

  } catch (err) {
    console.error(err);
    reset(`Something went wrong: ${err.message}`);
  }
}

// simple in-page consent dialog; resolves {cancelled} or {cap}
function askConsent(nGames, workers, estSeconds) {
  return new Promise((resolve) => {
    el('consent-detail').innerHTML =
      `${nGames} of your games haven't been analysed on Lichess. ` +
      `Your browser can analyse them with Stockfish using ${workers} parallel worker(s). ` +
      `Estimated time: <b>~${humanDuration(estSeconds)}</b>.`;
    const capNote = nGames > 300;
    el('consent-cap-row').style.display = capNote ? 'block' : 'none';
    if (capNote) el('consent-cap').value = 300;

    show('consent-panel');
    const cleanup = () => { hide('consent-panel'); btnGo.onclick = btnSkip.onclick = btnCancel.onclick = null; };
    const btnGo = el('consent-go'), btnSkip = el('consent-skip'), btnCancel = el('consent-cancel');

    btnGo.onclick = () => {
      const cap = capNote ? parseInt(el('consent-cap').value, 10) || nGames : nGames;
      cleanup(); resolve({ cap });
    };
    btnSkip.onclick = () => { cleanup(); resolve({ cap: 0 }); }; // analyse none, use pre-evaluated only
    btnCancel.onclick = () => { cleanup(); resolve({ cancelled: true }); };
  });
}

function reset(msg) {
  hide('progress-panel');
  hide('consent-panel');
  const errEl = el('intro-error');
  if (errEl) {
    if (msg) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    else errEl.classList.add('hidden');
  }
  show('intro');
  el('run-btn').disabled = false;
}

el('run-btn').addEventListener('click', run);
el('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
document.querySelectorAll('input[name="range"]').forEach(r =>
  r.addEventListener('change', () => {
    el('custom-dates').style.display =
      document.querySelector('input[name="range"]:checked').value === 'custom' ? 'flex' : 'none';
  }));
