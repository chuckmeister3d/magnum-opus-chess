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
let currentData = null;   // most recent report, for the "save/share report" button

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
  const includeBots = !!(el('include-bots') && el('include-bots').checked);
  const includeUnrated = !!(el('include-unrated') && el('include-unrated').checked);
  const perfs = Array.from(document.querySelectorAll('.perf-check:checked')).map(c => c.value);
  const rangeMode = document.querySelector('input[name="range"]:checked')?.value;
  if (rangeMode === 'custom' && !since && !until) {
    reset('Pick a "From" and/or "To" date for the range, or choose "All time".');
    return;
  }
  if (!perfs.length) {
    reset('Pick at least one time control (bullet, blitz, rapid, or classical).');
    return;
  }
  const perfTypes = perfs.join(',');
  let engineWarning = null;

  try {
    // ---- STEP 1: download ----
    setStep('download', 'active');
    setStatus(`Looking up ${username}…`);
    const totalEstimate = await pgn.fetchGameCount(username, token, perfs);

    setStatus(`Downloading ${username}'s games from Lichess…`);
    const pgnText = await pgn.fetchGamesPGN(username, {
      since, until, token, perfTypes, rated: !includeUnrated,
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
      const r = an.analyzeGame(g, username, null, { includeBots });
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
            const r = an.analyzeGame(toEval[i].game, username, evals, { includeBots });
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
    const data = an.rankIntoTabs(results, username, games.length, undefined, { includeBots, includeUnrated });
    currentData = data;
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

// Build a standalone, self-contained HTML copy of the current report: the data and
// piece SVGs are baked in and render.js is inlined, so the file renders on its own
// (no server, no re-analysis) and can be shared or reopened anywhere.
async function buildStandaloneReport(data) {
  await loadPieces();
  const renderSrc = await (await fetch('./render.js')).text();
  const styleEl = document.querySelector('style');
  const styles = styleEl ? styleEl.textContent : '';
  const root = document.getElementById('report-root').cloneNode(true);
  root.classList.remove('hidden');
  root.querySelectorAll('.panel').forEach((p, i) => { p.innerHTML = ''; p.classList.toggle('active', i === 0); });
  root.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  const ml = root.querySelector('#meta-line'); if (ml) ml.innerHTML = '';
  const te = root.querySelector('#tab-explainer'); if (te) te.textContent = '';
  const ew = root.querySelector('#engine-warning'); if (ew) { ew.textContent = ''; ew.classList.add('hidden'); }
  const ra = root.querySelector('.report-actions'); if (ra) ra.remove(); // no download button inside a downloaded file
  const shell = root.outerHTML;
  const renderInline = renderSrc.replace(/export\s+function\s+renderReport/, 'function renderReport');
  const enc = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c'); // keep </script> etc. from breaking out
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.meta.username}'s best Lichess games — Magnum Opus</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Work+Sans:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${styles}</style></head>
<body><div class="page">
<header class="page-header"><div class="eyebrow">Magnum Opus</div><h1 id="header-title">Best games</h1></header>
<p class="sub">A report from <a href="https://magnum-opus-chess.netlify.app" style="color:var(--brass);text-decoration:none">Magnum Opus</a> — make your own at magnum-opus-chess.netlify.app</p>
${shell}
</div>
<script id="game-data" type="application/json">${enc(data)}</script>
<script id="piece-data" type="application/json">${enc(PIECE_SVG)}</script>
<script>
${renderInline}
renderReport(JSON.parse(document.getElementById('game-data').textContent), JSON.parse(document.getElementById('piece-data').textContent));
</script>
</body></html>`;
}

function triggerDownload(filename, text) {
  const blob = new Blob([text], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

el('run-btn').addEventListener('click', run);

{
  const dlBtn = el('download-report');
  if (dlBtn) dlBtn.addEventListener('click', async () => {
    if (!currentData) return;
    const orig = dlBtn.textContent;
    dlBtn.textContent = 'Preparing…'; dlBtn.disabled = true;
    try {
      const html = await buildStandaloneReport(currentData);
      triggerDownload(`magnum-opus-${currentData.meta.username}.html`, html);
      dlBtn.textContent = orig;
    } catch (e) {
      console.error('MO: report download failed', e);
      dlBtn.textContent = 'Could not build file';
      setTimeout(() => { dlBtn.textContent = orig; }, 1800);
    }
    dlBtn.disabled = false;
  });
}
el('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
document.querySelectorAll('input[name="range"]').forEach(r =>
  r.addEventListener('change', () => {
    el('custom-dates').style.display =
      document.querySelector('input[name="range"]:checked').value === 'custom' ? 'flex' : 'none';
  }));
