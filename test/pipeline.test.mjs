// pipeline.test.mjs — offline regression test for the analysis pipeline.
// Runs the real pgn.js parser + analysis.js scorer/ranker under Node against a
// known game, exercising BOTH the stored-eval path and the engine-eval path.
// It does NOT touch the network or Stockfish — those are validated in a browser
// (see the "Testing on your machine" checklist in README.md).
//
//   node test/pipeline.test.mjs      (or: npm test)

import { parsePGN, gameHasEvals } from '../site/pgn.js';
import { analyzeGame, rankIntoTabs } from '../site/analysis.js';

// A real, legal 33-ply game (Morphy's "Opera Game") so chess.js accepts every SAN.
const sans = ["e4","e5","Nf3","d6","d4","Bg4","dxe5","Bxf3","Qxf3","dxe5","Bc4","Nf6",
"Qb3","Qe7","Nc3","c6","Bg5","b5","Nxb5","cxb5","Bxb5+","Nbd7","O-O-O","Rd8",
"Rxd7","Rxd7","Rd1","Qe6","Bxd7+","Nxd7","Qb8+","Nxb8","Rd8#"];

// Smooth white-POV ramp 0.20 -> 2.50 pawns: winning throughout, no per-ply swing >1.75.
const n = sans.length;
const evalsPawns = sans.map((_, i) => (0.20 + (2.30 * i / (n - 1))).toFixed(2));

function buildPGN(withEvals, evs = evalsPawns) {
  const headers = [
    ['Event','Rated Blitz game'],['Site','https://lichess.org/abcd1234'],
    ['White','testuser'],['Black','opponent'],['Result','1-0'],
    ['UTCDate','2024.05.01'],['UTCTime','12:00:00'],
    ['WhiteElo','1500'],['BlackElo','1900'],['Opening','Philidor Defense'],['Variant','Standard'],
  ].map(([k,v]) => `[${k} "${v}"]`).join('\n');
  let mt = '';
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) mt += `${i/2+1}. `;
    mt += sans[i];
    if (withEvals) mt += ` { [%eval ${evs[i]}] }`;
    mt += ' ';
  }
  mt += '1-0';
  return headers + '\n\n' + mt + '\n';
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

console.log('== Test 1: parse + instant (stored-eval) path ==');
const games = parsePGN(buildPGN(true));
ok(games.length === 1, `parsed 1 game (got ${games.length})`);
ok(games[0].moves.length === 33, `33 moves parsed (got ${games[0].moves.length})`);
ok(gameHasEvals(games[0]), 'gameHasEvals=true');
const r = analyzeGame(games[0], 'testuser');
ok(r && !r.NEEDS_ENGINE_EVAL, 'analyzeGame returned a full result');
ok(r.my_result === 'win', `my_result=win (got ${r && r.my_result})`);
ok(r.my_color === 'white', `my_color=white (got ${r && r.my_color})`);
ok(r.ply_count === 33, `ply_count=33 (got ${r && r.ply_count})`);
ok(r.blunder_free === true, `blunder_free=true (got ${r && r.blunder_free})`);
ok(r.worst_my_wp >= 40, `worst_my_wp>=40 (got ${r && r.worst_my_wp})`);
ok(r.best_my_wp >= 65, `best_my_wp>=65 — a real advantage (got ${r && r.best_my_wp})`);
ok(typeof r.combined_accuracy === 'number', `combined_accuracy is number (${r && r.combined_accuracy})`);
ok(r.all_fens.length === 34, `all_fens=34 (got ${r && r.all_fens && r.all_fens.length})`);
ok(r.ended_in_checkmate === true, `ended_in_checkmate=true — Opera game ends in Rd8# (got ${r && r.ended_in_checkmate})`);

console.log('== Test 2: ranking into the five tabs ==');
const data = rankIntoTabs([r], 'testuser', 1);
ok(['flawless','highest_rated','underdogs','wild_rides','swindles','endgame_grinds'].every(k => Array.isArray(data[k])), 'all six tab arrays present');
ok(data.flawless.length === 1, `game is Flawless (len ${data.flawless.length})`);
ok(data.highest_rated.length === 1, `game in Highest-Rated (len ${data.highest_rated.length})`);
ok(data.underdogs.length === 1 && data.underdogs[0].rating_diff === 400, `Underdog rating_diff=400 (got ${data.underdogs[0] && data.underdogs[0].rating_diff})`);
ok(data.meta.wins_analyzed === 1, `meta.wins_analyzed=1 (got ${data.meta.wins_analyzed})`);

console.log('== Test 3: engine-eval path (no stored evals) ==');
const games2 = parsePGN(buildPGN(false));
ok(!gameHasEvals(games2[0]), 'no stored evals in PGN');
const need = analyzeGame(games2[0], 'testuser');
ok(need && Array.isArray(need.NEEDS_ENGINE_EVAL), 'returns NEEDS_ENGINE_EVAL list');
ok(need.NEEDS_ENGINE_EVAL.length === 33, `needs 33 FENs (got ${need && need.NEEDS_ENGINE_EVAL && need.NEEDS_ENGINE_EVAL.length})`);
const engineEvals = evalsPawns.map(p => ({ type: 'cp', value: Math.round(parseFloat(p) * 100) }));
const r2 = analyzeGame(games2[0], 'testuser', engineEvals);
ok(r2 && !r2.NEEDS_ENGINE_EVAL, 'engine-eval re-analysis returns full result');
ok(r2.my_result === 'win' && r2.ply_count === 33, 'engine-eval result consistent (win, 33 plies)');
ok(Math.abs(r2.combined_accuracy - r.combined_accuracy) < 0.05, `engine vs stored accuracy match (${r2 && r2.combined_accuracy} vs ${r.combined_accuracy})`);

console.log('== Test 4: a non-participant username is skipped ==');
ok(analyzeGame(games[0], 'someone_else') === null, 'non-participant username -> null');

console.log('== Test 5: a dead-even win (e.g. won on time) is NOT flawless ==');
const flatEvals = sans.map(() => '0.05'); // ~50% win prob the whole game
const rEven = analyzeGame(parsePGN(buildPGN(true, flatEvals))[0], 'testuser');
ok(rEven && rEven.my_result === 'win', 'even game is still a win by result');
ok(rEven.best_my_wp < 65, `best_my_wp < 65 — never genuinely ahead (got ${rEven && rEven.best_my_wp})`);
ok(rEven.worst_my_wp >= 40, `worst_my_wp still >= 40 (got ${rEven && rEven.worst_my_wp})`);
const dataEven = rankIntoTabs([rEven], 'testuser', 1);
ok(dataEven.flawless.length === 0, 'dead-even win EXCLUDED from Flawless');
ok(dataEven.highest_rated.length === 1, 'dead-even win still appears in Highest-Rated');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
