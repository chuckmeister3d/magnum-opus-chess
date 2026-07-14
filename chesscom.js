// Magnum Opus. Copyright (C) 2026 Charles Davison.
// Free software under the GNU General Public License v3 or later; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// chesscom.js — fetch a player's games from the Chess.com public API and
// normalise them into the SAME { headers, moves, comments } shape that
// pgn.js#parsePGN produces, so the rest of the pipeline (analysis.js, render.js)
// treats Chess.com games exactly like Lichess ones.
//
// Chess.com's published-data API is public (no token) and sends
// Access-Control-Allow-Origin, so the browser can call it directly. Games are
// grouped into monthly archives. Unlike Lichess, the PGNs carry NO [%eval]
// comments, so every Chess.com game is evaluated locally with Stockfish.

import { parsePGN } from './pgn.js';

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Chess.com time classes -> the perf buckets the UI uses. "daily"
// (correspondence) is folded into "classical" so it rides the Classical toggle.
function perfOf(timeClass) {
  return timeClass === 'daily' ? 'classical' : timeClass;
}

// Fetch + normalise a Chess.com player's games. Returns an array of parsed games
// ({ headers, moves, comments }) ready for analysis.js#analyzeGame.
export async function fetchChesscomGames(username, { since = null, until = null,
    perfTypes = 'bullet,blitz,rapid,classical', rated = true, onProgress = null } = {}) {
  const u = encodeURIComponent(username.trim().toLowerCase());
  let listResp;
  try {
    listResp = await fetch(`https://api.chess.com/pub/player/${u}/games/archives`);
  } catch (e) {
    throw new Error(`Couldn't reach Chess.com. ${e.message}`);
  }
  if (listResp.status === 404) throw new Error(`No Chess.com player "${username}".`);
  if (!listResp.ok) throw new Error(`Chess.com archives request failed (${listResp.status}).`);
  const { archives = [] } = await listResp.json();

  const wanted = new Set(perfTypes.split(',').map(s => s.trim()).filter(Boolean));
  const sinceMs = since ? Date.parse(since + 'T00:00:00Z') : null;
  const untilMs = until ? Date.parse(until + 'T23:59:59Z') : null;

  // keep only the monthly archives that overlap the requested date range
  const inRange = archives.filter(url => {
    const m = url.match(/\/(\d{4})\/(\d{2})$/);
    if (!m) return true;
    const y = +m[1], mo = +m[2];
    const start = Date.UTC(y, mo - 1, 1);
    const end = Date.UTC(y, mo, 1) - 1;
    if (sinceMs && end < sinceMs) return false;
    if (untilMs && start > untilMs) return false;
    return true;
  });

  const out = [];
  const total = inRange.length;
  let done = 0;
  for (const archUrl of inRange) {
    if (onProgress) onProgress(out.length, done, total);
    let j;
    try {
      const r = await fetch(archUrl);
      if (!r.ok) { done++; continue; }
      j = await r.json();
    } catch { done++; continue; }
    for (const g of (j.games || [])) {
      if (g.rules !== 'chess') continue;            // standard chess only
      if (rated && !g.rated) continue;              // rated unless the user allowed unrated
      const perf = perfOf(g.time_class);
      if (!wanted.has(perf)) continue;              // time-control filter
      const endMs = (g.end_time || 0) * 1000;
      if (sinceMs && endMs && endMs < sinceMs) continue;
      if (untilMs && endMs && endMs > untilMs) continue;
      if (!g.pgn) continue;
      const parsedArr = parsePGN(g.pgn);
      if (!parsedArr.length) continue;
      const p = parsedArr[0];
      // Normalise headers so analysis.js reads them like a Lichess game:
      //  - Event must contain the perf keyword (bullet/blitz/rapid/classical)
      //  - Site must be the game URL (that's where the game id + link come from)
      p.headers.Event = `${g.rated ? 'Rated' : 'Casual'} ${cap(perf)} game`;
      p.headers.Site = g.url || p.headers.Link || p.headers.Site || '';
      if (g.white && g.white.title) p.headers.WhiteTitle = g.white.title;
      if (g.black && g.black.title) p.headers.BlackTitle = g.black.title;
      out.push(p);
    }
    done++;
    if (onProgress) onProgress(out.length, done, total);
  }
  return out;
}
