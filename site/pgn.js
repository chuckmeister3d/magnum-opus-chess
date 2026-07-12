// Magnum Opus. Copyright (C) 2026 Charles Davison.
// Free software under the GNU General Public License v3 or later; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// pgn.js — parse a multi-game PGN string into structured games, and fetch
// games directly from the Lichess API (browser -> Lichess, no server).

// Parse one game's movetext into { moves: [san...], comments: [str per ply] }.
// We strip variations, NAGs, and move numbers; keep the [%eval ...] comments
// aligned one-per-ply so analysis.js can read them.
function parseMovetext(movetext) {
  const moves = [];
  const comments = [];

  // Remove result token at the end
  movetext = movetext.replace(/\s*(1-0|0-1|1\/2-1\/2|\*)\s*$/, ' ');

  let i = 0;
  const n = movetext.length;
  let pendingComment = '';

  while (i < n) {
    const c = movetext[i];

    if (c === '{') {
      // comment block — capture, attach to the LAST move played
      const end = movetext.indexOf('}', i);
      const body = movetext.slice(i + 1, end === -1 ? n : end);
      if (moves.length > 0) {
        comments[moves.length - 1] = (comments[moves.length - 1] || '') + body;
      } else {
        pendingComment += body;
      }
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '(') {
      // variation — skip to matching close paren
      let depth = 1; i++;
      while (i < n && depth > 0) {
        if (movetext[i] === '(') depth++;
        else if (movetext[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }

    // read a token
    let j = i;
    while (j < n && !/\s|\{|\(/.test(movetext[j])) j++;
    let tok = movetext.slice(i, j);
    i = j;

    // skip move numbers like "12." or "12..."
    tok = tok.replace(/^\d+\.(\.\.)?/, '');
    if (!tok) continue;
    // skip NAGs ($1 etc) and bare result
    if (tok.startsWith('$')) continue;
    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') continue;
    // strip trailing move annotations like !, ?, !?, +, #
    // chess.js accepts + and # so keep those; strip !/? which it rejects
    tok = tok.replace(/[!?]+$/, '');
    if (!tok) continue;

    moves.push(tok);
    comments.push('');
  }
  // attach any leading comment to nothing (ignored)
  return { moves, comments };
}

function parseHeaders(headerBlock) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(headerBlock)) !== null) {
    headers[m[1]] = m[2];
  }
  return headers;
}

// Split a multi-game PGN into individual games.
export function parsePGN(pgnText) {
  const games = [];
  // Each game: a header block (lines starting with [) then a movetext block.
  // Games are separated by blank lines; a new game starts at a line beginning
  // with [Event.
  const chunks = pgnText.split(/\n\s*\n(?=\[Event )/);
  // The above splits on blank line followed by [Event. Also handle the very
  // first game and cases where header/movetext are separated by one blank line.
  for (const raw of pgnText.split(/(?=\[Event )/)) {
    if (!raw.trim()) continue;
    // separate header lines from movetext
    const lines = raw.split('\n');
    const headerLines = [];
    let k = 0;
    for (; k < lines.length; k++) {
      if (lines[k].trim().startsWith('[')) headerLines.push(lines[k]);
      else if (lines[k].trim() === '' && headerLines.length) continue;
      else break;
    }
    const movetext = lines.slice(k).join(' ').trim();
    const headers = parseHeaders(headerLines.join('\n'));
    if (!headers.Event && !movetext) continue;
    const { moves, comments } = parseMovetext(movetext);
    games.push({ headers, moves, comments });
  }
  return games;
}

export function gameHasEvals(parsed) {
  return parsed.comments.some(c => c && c.includes('%eval'));
}

// ---- Lichess fetch (browser -> lichess.org, streamed) ----
function toEpochMs(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d)) return null;
  return d.getTime();
}

// Best-effort total game count for the standard speeds we care about, used only
// to show "X of ~Y" during the download. One small JSON request (not throttled
// like the game stream). Returns a number, or null if it can't be read.
export async function fetchGameCount(username, token = null) {
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`, { headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    const perfs = data.perfs || {};
    let sum = 0, any = false;
    for (const s of ['bullet', 'blitz', 'rapid', 'classical']) {
      const g = perfs[s] && perfs[s].games;
      if (typeof g === 'number') { sum += g; any = true; }
    }
    if (any && sum > 0) return sum;         // games in the speeds we analyse
    const c = data.count || {};
    return c.rated || c.all || null;        // fallback: all rated games
  } catch {
    return null;
  }
}

export async function fetchGamesPGN(username, { since = null, until = null, token = null,
                                                perfTypes = 'bullet,blitz,rapid,classical',
                                                onProgress = null } = {}) {
  // NOTE: do NOT send `analysed`. On the Lichess API it is a *filter*
  // ("[Filter] Only games with or without a computer analysis available"), so
  // analysed=false would return ONLY un-analysed games and drop every game the
  // user already analysed on Lichess — exactly the ones with [%eval] we score
  // instantly. Omitting it returns all games; `evals=true` still attaches the
  // stored evals wherever Lichess has them, and we fill the rest with Stockfish.
  const params = new URLSearchParams({
    rated: 'true',
    tags: 'true',
    clocks: 'true',   // needed to tell a real time-forfeit from an opponent who left
    evals: 'true',
    opening: 'true',
    perfType: perfTypes,
  });
  const sinceMs = toEpochMs(since), untilMs = toEpochMs(until);
  if (sinceMs) params.set('since', sinceMs);
  if (untilMs) params.set('until', untilMs);

  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;
  const headers = { Accept: 'application/x-chess-pgn' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`Lichess returned ${resp.status} ${resp.statusText}. Check the username and try again.`);
  }

  // stream so we can show progress, counting games ('[Event ') as they arrive.
  // The counter is incremental (handles a token split across a chunk boundary)
  // so it stays cheap even on very large downloads.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '', received = 0, games = 0, carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    const piece = decoder.decode(value, { stream: true });
    text += piece;
    const scan = carry + piece;
    let idx = 0;
    while ((idx = scan.indexOf('[Event ', idx)) !== -1) { games++; idx += 7; }
    carry = scan.slice(-6); // 6 = len('[Event ') - 1, enough to catch a split token
    if (onProgress) onProgress(received, games);
  }
  text += decoder.decode();
  if (!text.trim()) {
    throw new Error(`No games found for "${username}" in that range.`);
  }
  return text;
}
