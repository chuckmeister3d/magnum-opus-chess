// Magnum Opus. Copyright (C) 2026 Charles Davison.
// Free software under the GNU General Public License v3 or later; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// analysis.js — faithful port of the Python `core.py` analysis engine.
// Uses chess.js for move parsing/board state. Every scoring rule, threshold,
// and category here mirrors the validated Python implementation 1:1.

import { Chess } from './vendor/chess.js';

// ===================== CONFIG (mirrors core.py) =====================
export const CONFIG = {
  PERF_TYPES: ['bullet', 'blitz', 'rapid', 'classical'],
  EXCLUDE_BOTS: true,
  STANDARD_ONLY: true,

  BLUNDER_THRESHOLD_PAWNS: 1.75,
  MIN_PLIES_FOR_LEADERBOARD: 30,
  MIN_WORST_WINPERCENT: 40,
  // A "flawless" win must reflect an advantage you actually earned — not a
  // dead-even game won on time or by resignation. Require your win% to have
  // reached at least this at some point (i.e. you were genuinely winning).
  FLAWLESS_MIN_BEST_WP: 65,

  SAC_MATERIAL_THRESHOLD: 2,
  SAC_LOOKAHEAD_PLIES: 2,
  SAC_MIN_WP_BEFORE: 45,
  CRUSHING_WINPERCENT: 92,
  SAC_MIN_WP_AFTER: 60,
  SAC_MAX_WP_GIVEBACK: 8,

  RATING_BONUS_CAP: 2.0,
  RATING_BONUS_SCALE: 100.0,

  TOP_N: 5,
  WILD_WINNING_MARGIN: 15,
  WILD_MIN_SWINGS: 3,
  WILD_MIN_PLIES: 20,

  SWINDLE_MAX_WORST_WP: 3,          // at the nadir you were essentially dead lost (<=3% win prob)
  SWINDLE_LOST_WP: 15,              // a LARGE deficit: <=15% win prob is roughly a piece-plus down,
                                    // not just "a bit worse" — a swindle needs real jeopardy
  SWINDLE_MIN_LOST_PLIES: 8,        // absolute floor (keeps short games eligible)
  SWINDLE_MIN_LOST_FRACTION: 0.20,  // AND you sat at that large deficit for at least this share of the
                                    // whole game, so "winning all game, one blunder, recovered" is out

  // A time-forfeit "win" where the opponent still had more than this many seconds
  // on their clock is treated as them leaving/abandoning, not a genuine flag.
  ABANDON_CLOCK_SEC: 15,

  // --- endgame detection (Flawless depth bonus + the Endgame Grinds tab) ---
  // A position counts as "in the endgame" when BOTH sides are at or below this much
  // non-pawn material (queen=9, rook=5, bishop/knight=3). 13 ≈ queens off, at most a
  // rook and a couple of minors each.
  ENDGAME_MAX_SIDE_NP: 13,
  // A win is an "endgame grind" if it stayed in the endgame for at least this many
  // consecutive plies.
  ENDGAME_GRIND_MIN_PLIES: 16,
  // Flawless wins get a small ranking nudge for going the distance, so quick wins
  // stop crowding out the deeper ones.
  FLAWLESS_CHECKMATE_BONUS: 3.0,
  FLAWLESS_ENDGAME_BONUS: 2.0,
};

const CRITICALITY_RANK = {
  only_move_forces_mate: 5,
  only_good_option: 4,
  mate_multiple_ways: 3,
  best_move: 2,
  near_best: 1,
  not_top_choice: -1,
  null: 0,
};

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// ===================== win% / accuracy math =====================
export function cpToWinpercent(cp) {
  cp = Math.max(Math.min(cp, 1000), -1000);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function mateToWinpercent(mate) {
  return mate > 0 ? 100.0 : 0.0;
}

// eval is {type:'cp'|'mate', value:number} or null
export function evalToPawns(e, cap = 5.0) {
  if (e == null) return null;
  let val;
  if (e.type === 'mate') val = e.value > 0 ? cap : -cap;
  else val = e.value / 100.0;
  return Math.max(-cap, Math.min(val, cap));
}

const _A = 103.1668100711649, _K = 0.04354415386753951, _B = -3.166924740191411;

function moveAccuracy(before, after) {
  if (after >= before) return 100.0;
  const winDiff = before - after;
  const raw = _A * Math.exp(-_K * winDiff) + _B + 1;
  return Math.min(100.0, Math.max(0.0, raw));
}

function pstdev(arr) {
  if (arr.length < 2) return 0.0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
  return Math.sqrt(v);
}

export function gameAccuracy(winpercents) {
  const numMoves = winpercents.length - 1;
  if (numMoves < 1) return [null, null, 0, 0];

  let windowSize = Math.max(2, Math.min(Math.floor(numMoves / 10), 8));
  windowSize = Math.min(windowSize, winpercents.length);

  const firstWindow = winpercents.slice(0, windowSize);
  const padCount = Math.max(0, windowSize - 2);
  const windows = [];
  for (let i = 0; i < padCount; i++) windows.push(firstWindow);
  for (let i = 0; i <= winpercents.length - windowSize; i++) {
    windows.push(winpercents.slice(i, i + windowSize));
  }

  const weights = windows.map(w => Math.max(0.5, Math.min(pstdev(w), 12.0)));

  const n = Math.min(numMoves, weights.length);
  const perColor = { white: [], black: [] };
  const perPlyDrop = [];

  for (let i = 0; i < n; i++) {
    const prev = winpercents[i], nxt = winpercents[i + 1];
    const isWhite = (i % 2 === 0);
    let acc, drop;
    if (isWhite) { acc = moveAccuracy(prev, nxt); drop = prev - nxt; }
    else { acc = moveAccuracy(nxt, prev); drop = nxt - prev; }
    const color = isWhite ? 'white' : 'black';
    perColor[color].push([acc, weights[i]]);
    perPlyDrop.push([color, Math.max(0.0, drop)]);
  }

  function combine(vals) {
    if (!vals.length) return null;
    const wtot = vals.reduce((a, [, w]) => a + w, 0);
    const weightedMean = vals.reduce((a, [v, w]) => a + v * w, 0) / wtot;
    const safe = vals.map(([v]) => Math.max(v, 1e-6));
    const harmonic = safe.length / safe.reduce((a, v) => a + 1 / v, 0);
    return (weightedMean + harmonic) / 2;
  }

  const whiteAcc = combine(perColor.white);
  const blackAcc = combine(perColor.black);
  const dropsW = perPlyDrop.filter(([c]) => c === 'white').map(([, d]) => d);
  const dropsB = perPlyDrop.filter(([c]) => c === 'black').map(([, d]) => d);
  const maxDropWhite = dropsW.length ? Math.max(...dropsW) : 0.0;
  const maxDropBlack = dropsB.length ? Math.max(...dropsB) : 0.0;

  return [whiteAcc, blackAcc, maxDropWhite, maxDropBlack];
}

// ===================== eval comment parsing =====================
const EVAL_RE = /\[%eval\s+(#?-?\d+(?:\.\d+)?)\]/;

export function parseEvalFromComment(comment) {
  if (!comment) return null;
  const m = comment.match(EVAL_RE);
  if (!m) return null;
  const val = m[1];
  if (val.startsWith('#')) return { type: 'mate', value: parseInt(val.slice(1), 10) };
  return { type: 'cp', value: Math.round(parseFloat(val) * 100) };
}

// Parse a [%clk H:M:S] or [%clk M:S] comment into seconds remaining, or null.
const CLK_RE = /\[%clk\s+(\d+):(\d+)(?::(\d+))?\]/;
function parseClockSeconds(comment) {
  if (!comment) return null;
  const m = comment.match(CLK_RE);
  if (!m) return null;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  const c = m[3] != null ? parseInt(m[3], 10) : null;
  return c != null ? a * 3600 + b * 60 + c : a * 60 + b;
}

function materialValue(chess, color) {
  // color: 'w' | 'b'
  let total = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.color === color) total += PIECE_VALUES[sq.type];
    }
  }
  return total;
}

// non-pawn material for one side (queens/rooks/bishops/knights; king counts 0)
function nonPawnMaterial(chess, color) {
  let total = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.color === color && sq.type !== 'p') total += PIECE_VALUES[sq.type];
    }
  }
  return total;
}

// square name 'e4' -> [file 0-7, rank 0-7]
function sqToFileRank(sq) {
  return [sq.charCodeAt(0) - 97, parseInt(sq[1], 10) - 1];
}

// ===================== the big one: analyzeGame =====================
// pgnGame: { headers: {...}, moves: [{san, from, to, uci}], comments: [str per ply] }
// We parse moves ourselves with chess.js from the SAN list.
export function analyzeGame(parsed, username, precomputedEvals = null, opts = {}) {
  const h = parsed.headers;
  const whiteName = (h.White || '').toLowerCase();
  const blackName = (h.Black || '').toLowerCase();

  let myColor;
  if (whiteName === username.toLowerCase()) myColor = 'w';
  else if (blackName === username.toLowerCase()) myColor = 'b';
  else return null;

  if (CONFIG.STANDARD_ONLY && (h.Variant || 'Standard') !== 'Standard') return null;

  if (!opts.includeBots) {  // exclude games against bots unless the user opts in
    const oppTitle = myColor === 'w' ? h.BlackTitle : h.WhiteTitle;
    if (oppTitle === 'BOT') return null;
  }

  const event = (h.Event || '').toLowerCase();
  if (!CONFIG.PERF_TYPES.some(p => event.includes(p))) return null;

  const result = h.Result || '';
  const winner = result === '1-0' ? 'w' : result === '0-1' ? 'b' : null;
  let myResult;
  if (winner === myColor) myResult = 'win';
  else if (winner === null && result === '1/2-1/2') myResult = 'draw';
  else if (winner !== null) myResult = 'loss';
  else return null;

  // Replay moves
  const chess = new Chess();
  const sans = [], moves = [], fensBefore = [];
  const mdWhite = [materialValue(chess, 'w') - materialValue(chess, 'b')];
  const wNP = [nonPawnMaterial(chess, 'w')], bNP = [nonPawnMaterial(chess, 'b')];

  for (const san of parsed.moves) {
    fensBefore.push(chess.fen());
    let mv;
    try {
      mv = chess.move(san);
    } catch (e) {
      break; // malformed move; stop here
    }
    if (!mv) break;
    sans.push(mv.san);
    moves.push({ from: mv.from, to: mv.to });
    mdWhite.push(materialValue(chess, 'w') - materialValue(chess, 'b'));
    wNP.push(nonPawnMaterial(chess, 'w'));
    bNP.push(nonPawnMaterial(chess, 'b'));
  }

  let evals;
  if (precomputedEvals !== null) {
    evals = precomputedEvals.slice(0, sans.length);
    while (evals.length < sans.length) evals.push(null);
  } else {
    evals = parsed.comments.slice(0, sans.length).map(parseEvalFromComment);
    while (evals.length < sans.length) evals.push(null);
  }

  const finalFen = chess.fen();
  const endedInStalemate = chess.isStalemate();
  const endedInCheckmate = chess.isCheckmate();
  const allFens = [...fensBefore, finalFen];
  const plyCount = sans.length;
  if (plyCount < 6) return null;

  // Endgame reach: the longest run of consecutive plies where BOTH sides are at or
  // below the endgame material ceiling. wNP/bNP are indexed like allFens.
  let egRun = 0, egBest = 0, egStart = 0, egBestStart = 0;
  for (let i = 0; i < wNP.length; i++) {
    if (Math.max(wNP[i], bNP[i]) <= CONFIG.ENDGAME_MAX_SIDE_NP) {
      if (egRun === 0) egStart = i;
      egRun++;
      if (egRun > egBest) { egBest = egRun; egBestStart = egStart; }
    } else egRun = 0;
  }
  const reachedEndgame = egBest > 0;

  if (evals.every(e => e == null)) {
    if (precomputedEvals === null) {
      return { NEEDS_ENGINE_EVAL: allFens.slice(1) };
    }
    return null;
  }

  const winpercents = [50.0];
  for (const e of evals) {
    let wp;
    if (e == null) wp = winpercents[winpercents.length - 1];
    else if (e.type === 'mate') wp = mateToWinpercent(e.value);
    else wp = cpToWinpercent(e.value);
    winpercents.push(wp);
  }

  const [whiteAcc, blackAcc] = gameAccuracy(winpercents);
  if (whiteAcc == null) return null;

  const myAccuracy = myColor === 'w' ? whiteAcc : blackAcc;
  const oppAccuracy = myColor === 'w' ? blackAcc : whiteAcc;

  // blunder gate (pawns)
  const whitePawns = [0.0];
  for (const e of evals) {
    const p = evalToPawns(e);
    whitePawns.push(p == null ? whitePawns[whitePawns.length - 1] : p);
  }
  let myMaxDrop = 0.0, oppMaxDrop = 0.0;
  for (let i = 0; i < plyCount; i++) {
    const moverIsWhite = (i % 2 === 0);
    const prev = whitePawns[i], nxt = whitePawns[i + 1];
    const drop = moverIsWhite ? (prev - nxt) : (nxt - prev);
    if (moverIsWhite === (myColor === 'w')) myMaxDrop = Math.max(myMaxDrop, drop);
    else oppMaxDrop = Math.max(oppMaxDrop, drop);
  }
  const blunderFree = myMaxDrop < CONFIG.BLUNDER_THRESHOLD_PAWNS
    && oppMaxDrop < CONFIG.BLUNDER_THRESHOLD_PAWNS;

  // move glyphs (win%)
  const moveGlyphs = [];
  for (let i = 0; i < plyCount; i++) {
    const moverIsWhite = (i % 2 === 0);
    const b = winpercents[i], a = winpercents[i + 1];
    const drop = moverIsWhite ? (b - a) : (a - b);
    if (drop >= 30) moveGlyphs.push('??');
    else if (drop >= 20) moveGlyphs.push('?');
    else if (drop >= 10) moveGlyphs.push('?!');
    else moveGlyphs.push('');
  }

  // move squares
  const moveSquares = moves.map(m => {
    const [ff, fr] = sqToFileRank(m.from);
    const [tf, tr] = sqToFileRank(m.to);
    return [ff, fr, tf, tr];
  });

  // my win% perspective
  const myWp = myColor === 'w' ? winpercents.slice() : winpercents.map(w => 100 - w);
  const worstMyWp = Math.min(...myWp);
  const bestMyWp = Math.max(...myWp);

  // sacrifice detection
  const sacCandidates = [];
  for (let i = 0; i < plyCount; i++) {
    const moverIsWhite = (i % 2 === 0);
    if (moverIsWhite !== (myColor === 'w')) continue;
    if (i + 1 >= plyCount) continue;

    const oppReply = moves[i + 1];
    if (oppReply.to !== moves[i].to) continue;
    // was opponent's reply a capture? check board before reply
    const boardBeforeReply = new Chess(fensBefore[i + 1]);
    const replyIsCapture = boardBeforeReply.get(oppReply.to) != null;
    if (!replyIsCapture) continue;

    const boardBeforeMyMove = new Chess(fensBefore[i]);
    if (boardBeforeMyMove.inCheck()) continue; // forced response, not a sac

    const diffBefore = moverIsWhite ? mdWhite[i] : -mdWhite[i];
    const settlePly = Math.min(i + 1 + CONFIG.SAC_LOOKAHEAD_PLIES, plyCount);
    const settledDiff = moverIsWhite ? mdWhite[settlePly] : -mdWhite[settlePly];
    const sacAmount = diffBefore - settledDiff;
    if (sacAmount < CONFIG.SAC_MATERIAL_THRESHOLD) continue;

    const wpBefore = myWp[i];
    const wpAfter = myWp[Math.min(i + 2, myWp.length - 1)];
    const settleWp = myWp[Math.min(i + 1 + CONFIG.SAC_LOOKAHEAD_PLIES, plyCount)];

    if (wpBefore < CONFIG.SAC_MIN_WP_BEFORE) continue;
    if (wpBefore >= CONFIG.CRUSHING_WINPERCENT) continue;
    if (settleWp < CONFIG.SAC_MIN_WP_AFTER) continue;
    if (settleWp < wpBefore - CONFIG.SAC_MAX_WP_GIVEBACK) continue;

    sacCandidates.push({
      ply: i + 1,
      move_number: Math.floor(i / 2) + 1,
      san: sans[i],
      sac_amount: Math.round(sacAmount * 10) / 10,
      wp_before: Math.round(wpBefore * 10) / 10,
      wp_after: Math.round(wpAfter * 10) / 10,
      wp_settled: Math.round(settleWp * 10) / 10,
      fen_before: fensBefore[i],
      criticality: null,
      top_move_san: null,
    });
  }

  const site = h.Site || '';
  const gameId = site ? site.replace(/\/$/, '').split('/').pop() : '?';
  const myRating = myColor === 'w' ? h.WhiteElo : h.BlackElo;
  const oppRating = myColor === 'w' ? h.BlackElo : h.WhiteElo;
  const oppName = myColor === 'w' ? h.Black : h.White;
  const combinedAccuracy = (myAccuracy + oppAccuracy) / 2;
  const gameDate = (h.UTCDate || h.Date || '').replace(/\./g, '-');
  // Open the game from the player's side (Lichess flips the board with /black).
  const baseUrl = (site || `https://lichess.org/${gameId}`).replace(/\/$/, '');
  const gameUrl = myColor === 'b' ? `${baseUrl}/black` : baseUrl;
  const perf = CONFIG.PERF_TYPES.find(p => event.includes(p)) || '';
  // Tell a genuine time-forfeit (opponent flagged in time trouble) from an
  // opponent who left: look at the opponent's clock on their last move.
  const clocks = parsed.comments.slice(0, sans.length).map(parseClockSeconds);
  const oppIsWhite = myColor === 'b';
  let oppLastClock = null;
  for (let i = 0; i < clocks.length; i++) {
    if ((i % 2 === 0) === oppIsWhite && clocks[i] != null) oppLastClock = clocks[i];
  }
  const termination = h.Termination || '';
  const wonOnTime = myResult === 'win' && termination === 'Time forfeit';
  const oppAbandoned = wonOnTime && oppLastClock != null && oppLastClock > CONFIG.ABANDON_CLOCK_SEC;

  const r1 = x => Math.round(x * 10) / 10;
  const r2 = x => Math.round(x * 100) / 100;

  return {
    id: gameId,
    url: gameUrl,
    perf: perf,
    won_on_time: wonOnTime,
    opp_abandoned: oppAbandoned,
    termination: termination,
    date: gameDate,
    my_color: myColor === 'w' ? 'white' : 'black',
    my_result: myResult,
    my_rating: myRating,
    opp_rating: oppRating,
    opp_name: oppName,
    opening: h.Opening || '',
    ply_count: plyCount,
    my_accuracy: r1(myAccuracy),
    opp_accuracy: r1(oppAccuracy),
    combined_accuracy: r1(combinedAccuracy),
    blunder_free: blunderFree,
    my_max_drop_pawns: r2(myMaxDrop),
    opp_max_drop_pawns: r2(oppMaxDrop),
    worst_my_wp: r1(worstMyWp),
    best_my_wp: r1(bestMyWp),
    sac_candidates: sacCandidates,
    winpc: myWp.map(r1),
    final_fen: finalFen,
    all_fens: allFens,
    sans: sans,
    move_glyphs: moveGlyphs,
    move_squares: moveSquares,
    ended_in_stalemate: endedInStalemate,
    ended_in_checkmate: endedInCheckmate,
    reached_endgame: reachedEndgame,
    endgame_run: egBest,
    endgame_start_ply: egBestStart,
  };
}

// ===================== scoring helpers =====================
export function ratingDiff(g) {
  const o = parseInt(g.opp_rating, 10), m = parseInt(g.my_rating, 10);
  if (isNaN(o) || isNaN(m)) return 0;
  return o - m;
}

export function longestLostStreak(g, threshold = CONFIG.SWINDLE_LOST_WP) {
  let best = 0, cur = 0;
  for (const w of g.winpc) {
    if (w <= threshold) { cur++; best = Math.max(best, cur); }
    else cur = 0;
  }
  return best;
}

export function leaderboardScore(g) {
  const rd = ratingDiff(g);
  const bonus = Math.max(-CONFIG.RATING_BONUS_CAP,
    Math.min(rd / CONFIG.RATING_BONUS_SCALE, CONFIG.RATING_BONUS_CAP));
  // Reward wins that went the distance so short games stop dominating: a nudge for
  // finishing with checkmate and for grinding into a real endgame.
  const depthBonus = (g.ended_in_checkmate ? CONFIG.FLAWLESS_CHECKMATE_BONUS : 0)
    + (g.reached_endgame ? CONFIG.FLAWLESS_ENDGAME_BONUS : 0);
  return [Math.round((g.combined_accuracy + bonus + depthBonus) * 100) / 100, rd];
}

export function bestTactic(g) {
  const good = g.sac_candidates.filter(c => c.criticality !== 'not_top_choice');
  if (!good.length) return [null, null];
  good.sort((a, b) => {
    const ra = CRITICALITY_RANK[a.criticality] ?? 0, rb = CRITICALITY_RANK[b.criticality] ?? 0;
    if (rb !== ra) return rb - ra;
    return b.sac_amount - a.sac_amount;
  });
  const best = good[0];
  const key = (CRITICALITY_RANK[best.criticality] ?? 0) * 30 + best.sac_amount * 5 + g.my_accuracy * 0.3;
  return [best, key];
}

export function wildRideStats(g) {
  const wp = g.winpc;
  if (wp.length < CONFIG.WILD_MIN_PLIES) return null;
  const hi = 50 + CONFIG.WILD_WINNING_MARGIN, lo = 50 - CONFIG.WILD_WINNING_MARGIN;
  const zones = [];
  for (const w of wp) {
    if (w >= hi) zones.push(1);
    else if (w <= lo) zones.push(-1);
  }
  const compressed = [];
  for (const z of zones) {
    if (!compressed.length || compressed[compressed.length - 1] !== z) compressed.push(z);
  }
  let swings = 0;
  for (let i = 0; i < compressed.length - 1; i++) {
    if (compressed[i] !== compressed[i + 1]) swings++;
  }
  const depthFactor = Math.max(0, 50 - g.worst_my_wp);
  const [tactic] = bestTactic(g);
  const tacticBonus = tactic ? 15 : 0;
  const score = swings * 20 + depthFactor + tacticBonus;
  return { swings, score, has_tactic: !!tactic, tactic };
}

// ===================== ranking into the five tabs =====================
export function rankIntoTabs(results, username, nSeen, topN = CONFIG.TOP_N, opts = {}) {
  const wins = results.filter(r => r.my_result === 'win');

  // Flawless
  const flawlessPool = wins.filter(r => r.blunder_free
    && r.ply_count >= CONFIG.MIN_PLIES_FOR_LEADERBOARD
    && r.worst_my_wp >= CONFIG.MIN_WORST_WINPERCENT
    && r.best_my_wp >= CONFIG.FLAWLESS_MIN_BEST_WP);
  for (const r of flawlessPool) {
    const [s, rd] = leaderboardScore(r);
    r.leaderboard_score = s; r.rating_diff = rd;
  }
  flawlessPool.sort((a, b) => b.leaderboard_score - a.leaderboard_score);
  const flawless = flawlessPool.slice(0, topN);

  // Highest-rated
  for (const r of wins) r.rating_diff = ratingDiff(r);
  const highestRated = [...wins].sort((a, b) => parseInt(b.opp_rating) - parseInt(a.opp_rating)).slice(0, topN);

  // Underdogs
  const underdogs = [...wins].sort((a, b) => b.rating_diff - a.rating_diff).slice(0, topN);

  // Wild rides
  const wildPool = [];
  for (const r of wins) {
    const stats = wildRideStats(r);
    if (stats && stats.swings >= CONFIG.WILD_MIN_SWINGS) {
      wildPool.push({ ...r, _wild: stats, _best_tactic: stats.tactic });
    }
  }
  wildPool.sort((a, b) => b._wild.score - a._wild.score);
  const wildRides = wildPool.slice(0, topN);

  // Swindles
  const swindlePool = [];
  for (const r of results) {
    if (r.worst_my_wp > CONFIG.SWINDLE_MAX_WORST_WP) continue;
    if (!(r.my_result === 'win' || (r.my_result === 'draw' && r.ended_in_stalemate))) continue;
    if (r.opp_abandoned) continue;  // opponent left with time on the clock, not a real escape
    const streak = longestLostStreak(r);
    // Require the losing stretch to be a real share of the game (not just a brief
    // blip in an otherwise-winning game), with an absolute floor so short games
    // can still qualify.
    const needLost = Math.max(CONFIG.SWINDLE_MIN_LOST_PLIES,
                              Math.ceil(CONFIG.SWINDLE_MIN_LOST_FRACTION * r.ply_count));
    if (streak < needLost) continue;
    r.rating_diff = ratingDiff(r);
    r.lost_streak = streak;
    swindlePool.push(r);
  }
  swindlePool.sort((a, b) => (b.lost_streak - a.lost_streak) || (parseInt(b.opp_rating) - parseInt(a.opp_rating)));
  const swindles = swindlePool.slice(0, topN);

  // Endgame grinds: wins that stayed in a low-material endgame for a sustained
  // stretch (both sides pared down) and were still converted.
  const endgamePool = wins.filter(r => !r.opp_abandoned
    && r.endgame_run >= CONFIG.ENDGAME_GRIND_MIN_PLIES);
  endgamePool.sort((a, b) => (b.endgame_run - a.endgame_run)
    || (parseInt(b.opp_rating) - parseInt(a.opp_rating)));
  const endgameGrinds = endgamePool.slice(0, topN);

  const dates = results.map(r => r.date).filter(Boolean).sort();
  const engineCount = results.filter(r => r.evals_from === 'engine').length;
  const meta = {
    username,
    games_scanned: nSeen,
    games_analyzed: results.length,
    wins_analyzed: wins.length,
    engine_evaluated: engineCount,
    include_bots: !!opts.includeBots,
    include_unrated: !!opts.includeUnrated,
    flawless_pool_size: flawlessPool.length,
    date_from: dates.length ? dates[0] : null,
    date_to: dates.length ? dates[dates.length - 1] : null,
  };

  return { meta, flawless, highest_rated: highestRated, underdogs, wild_rides: wildRides, swindles, endgame_grinds: endgameGrinds };
}
