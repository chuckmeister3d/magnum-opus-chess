// Magnum Opus. Copyright (C) 2026 Charles Davison.
// Free software under the GNU General Public License v3 or later; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// render.js — the report UI (tabs, board scrubber, graph). Extracted from
// the standalone report template so the website can call it after analysis.

export function renderReport(DATA, PIECE_SVG) {
// DATA and PIECE_SVG are passed in as arguments

const EXPLAINERS = {
  flawless: "Wins where neither player blundered (no move dropped the evaluation by 1.75 pawns or more) and you were never close to losing (win probability stayed above 40% the whole game). Sorted by the two players' average accuracy.",
  highest_rated: "The highest-rated players you have beaten. No other filter, just sorted by their rating.",
  underdogs: "Wins against players rated above you, sorted by how big the rating gap was.",
  wild_rides: "Wins where the evaluation swung back and forth between winning and losing several times before the game settled. If you played a sound sacrifice along the way, the game moves up the list.",
  swindles: "Games where you were losing badly (win probability under 3% at the worst) and stayed well behind for a good part of the game, but still won or drew by stalemate.",
};

const CRIT_LABEL = {
  only_move_forces_mate: 'only move, forces mate',
  only_good_option: 'only good option',
  mate_multiple_ways: 'mate, multiple ways',
  best_move: "engine's top choice",
  near_best: 'near best',
};

function sign(n) { return n >= 0 ? '+' : ''; }
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function colorDot(color) { return `<span class="color-dot ${color}" title="played ${color}"></span>`; }

function accBar(myAcc, oppAcc) {
  const total = (myAcc + oppAcc) || 1;
  const myPct = (myAcc / total * 100);
  return `<div class="acc-bar">
      <div class="acc-seg you" style="width:${myPct.toFixed(1)}%"></div>
      <div class="acc-seg opp" style="width:${(100 - myPct).toFixed(1)}%"></div>
    </div>
    <div class="acc-labels"><span>you ${myAcc.toFixed(1)}</span><span>${oppAcc.toFixed(1)} opp</span></div>`;
}

// ---- board rendering ----
function parseFEN(fen) {
  return fen.split(' ')[0].split('/').map(row => {
    const arr = [];
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let k = 0; k < parseInt(ch, 10); k++) arr.push(null); }
      else arr.push(ch);
    }
    return arr;
  });
}

function boardInner(fen, myColor, lastMove, glyph) {
  const rows = parseFEN(fen);
  const whiteAtBottom = myColor === 'white';
  const SQ = 45;

  // map a file/rank (0-7, from White's view) to draw x/y honoring board orientation
  function xy(file, rank) {
    const drawCol = whiteAtBottom ? file : 7 - file;
    const drawRow = whiteAtBottom ? 7 - rank : rank;
    return [drawCol * SQ, drawRow * SQ];
  }

  let squares = '', highlights = '', pieces = '';
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    for (let f = 0; f < 8; f++) {
      const drawRow = whiteAtBottom ? r : 7 - r;
      const drawCol = whiteAtBottom ? f : 7 - f;
      const x = drawCol * SQ, y = drawRow * SQ;
      const isLight = (rank + f) % 2 === 0;
      squares += `<rect x="${x}" y="${y}" width="${SQ}" height="${SQ}" style="fill:${isLight ? 'var(--sq-light)' : 'var(--sq-dark)'}"/>`;
      const piece = rows[r][f];
      if (piece) {
        const code = (piece === piece.toUpperCase() ? 'w' : 'b') + piece.toUpperCase();
        pieces += `<g transform="translate(${x},${y})" data-piece>${PIECE_SVG[code]}</g>`;
      }
    }
  }

  // last-move highlight: shade the from and to squares
  let glyphMarkup = '';
  if (lastMove) {
    const [ff, fr, tf, tr] = lastMove;
    for (const [file, rank] of [[ff, fr], [tf, tr]]) {
      const [x, y] = xy(file, rank);
      highlights += `<rect x="${x}" y="${y}" width="${SQ}" height="${SQ}" class="last-move"/>`;
    }
    // glyph badge on the destination square (top-right corner), Lichess-style
    if (glyph) {
      const [tx, ty] = xy(tf, tr);
      const cls = glyph === '??' ? 'glyph-blunder' : glyph === '?' ? 'glyph-mistake' : 'glyph-inaccuracy';
      const cx = tx + SQ - 8, cy = ty + 8;
      glyphMarkup = `<circle cx="${cx}" cy="${cy}" r="9" class="${cls}"/>
        <text x="${cx}" y="${cy + 0.5}" font-size="11" text-anchor="middle" dominant-baseline="central" class="glyph-text">${glyph}</text>`;
    }
  }

  return squares + highlights + pieces + glyphMarkup;
}

// ---- graph rendering ----
// The area+line live in a stretched SVG (preserveAspectRatio="none") so they
// fill the panel width regardless of move count. A marker circle inside that
// SVG would be stretched into an oval - which is exactly why it looked wrong
// before. So the marker is drawn SEPARATELY as an absolutely-positioned HTML
// dot layered on top, positioned by percentage, staying perfectly round.
function graphSVG(winpc, markerPly) {
  const W = 640, H = 90, PAD = 4;
  const n = winpc.length;
  const X = i => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const Y = v => PAD + (1 - v / 100) * (H - 2 * PAD);
  let line = '';
  winpc.forEach((v, i) => { line += (i === 0 ? 'M' : 'L') + X(i).toFixed(1) + ',' + Y(v).toFixed(1) + ' '; });
  const area = line + `L ${X(n - 1).toFixed(1)},${(H - PAD).toFixed(1)} L ${X(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;
  const midY = Y(50).toFixed(1);

  let markerDot = '';
  if (markerPly !== undefined && markerPly !== null) {
    const mi = Math.max(0, Math.min(markerPly, n - 1));
    const leftPct = (X(mi) / W) * 100;
    const topPct = (Y(winpc[mi]) / H) * 100;
    markerDot = `<div class="graph-dot" style="left:${leftPct.toFixed(2)}%;top:${topPct.toFixed(2)}%"></div>`;
  }
  return `<div class="graph-inner">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="graph">
        <line x1="${PAD}" y1="${midY}" x2="${W - PAD}" y2="${midY}" class="graph-mid"/>
        <path d="${area}" class="graph-area"/>
        <path d="${line.trim()}" class="graph-line"/>
      </svg>
      ${markerDot}
    </div>`;
}

// ---- scrubber state, one entry per rendered card ----
const scrubState = {};

function cardKey(tab, gameId) { return `${tab}__${gameId}`; }

function renderScrub(key) {
  const st = scrubState[key];
  const board = document.getElementById('board-' + key);
  const slider = document.getElementById('slider-' + key);
  const label = document.getElementById('label-' + key);
  const graphHolder = document.getElementById('graph-' + key);
  const playBtn = document.getElementById('play-' + key);

  // last move is the one that LED to the current position (ply>0)
  const moveIdx = st.ply - 1;  // index into sans/glyphs/squares
  const lastMove = st.ply > 0 ? st.squares[moveIdx] : null;
  const glyph = st.ply > 0 ? st.glyphs[moveIdx] : '';

  board.innerHTML = boardInner(st.fens[st.ply], st.myColor, lastMove, glyph);
  slider.value = st.ply;
  graphHolder.innerHTML = graphSVG(st.winpc, st.ply);

  const GLYPH_NAME = { '??': ' (blunder)', '?': ' (mistake)', '?!': ' (inaccuracy)' };
  if (st.ply === 0) {
    label.innerHTML = 'Starting position';
  } else {
    const moveNo = Math.ceil(st.ply / 2);
    const isFinal = st.ply === st.fens.length - 1;
    const glyphName = GLYPH_NAME[glyph] || '';
    label.innerHTML = `<span class="mv">Move ${moveNo}</span> \u00b7 ${st.sans[moveIdx]}${glyph}${glyphName}${isFinal ? ' \u00b7 final' : ''}`;
  }
  playBtn.textContent = st.playing ? '\u23F8' : '\u25B6';
}

function setPly(key, ply) {
  const st = scrubState[key];
  st.ply = Math.max(0, Math.min(ply, st.fens.length - 1));
  renderScrub(key);
}

function stepBy(key, delta) { setPly(key, scrubState[key].ply + delta); }

function togglePlay(key) {
  const st = scrubState[key];
  if (st.playing) {
    clearInterval(st.timer);
    st.playing = false;
  } else {
    if (st.ply >= st.fens.length - 1) st.ply = 0; // restart from the beginning if at the end
    st.playing = true;
    st.timer = setInterval(() => {
      if (st.ply >= st.fens.length - 1) {
        clearInterval(st.timer);
        st.playing = false;
        renderScrub(key);
        return;
      }
      setPly(key, st.ply + 1);
    }, 650);
  }
  renderScrub(key);
}

let focusedKey = null;

function focusCard(key) {
  focusedKey = key;
  document.querySelectorAll('[data-scrub-key]').forEach(el => {
    el.classList.toggle('focused', el.dataset.scrubKey === key);
  });
}

function initScrubbers(container) {
  container.querySelectorAll('[data-scrub-key]').forEach(el => {
    const key = el.dataset.scrubKey;
    if (!scrubState[key]) return;
    el.addEventListener('mouseenter', () => focusCard(key));
    el.querySelectorAll('.scrub-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        focusCard(key);
        const st = scrubState[key];
        switch (btn.dataset.action) {
          case 'start': if (st.playing) togglePlay(key); setPly(key, 0); break;
          case 'prev': if (st.playing) togglePlay(key); stepBy(key, -1); break;
          case 'play': togglePlay(key); break;
          case 'next': if (st.playing) togglePlay(key); stepBy(key, 1); break;
          case 'end': if (st.playing) togglePlay(key); setPly(key, st.fens.length - 1); break;
        }
      });
    });
    const slider = el.querySelector('.scrub-slider');
    slider.addEventListener('input', () => {
      focusCard(key);
      if (scrubState[key].playing) togglePlay(key);
      setPly(key, parseInt(slider.value, 10));
    });
    const graphHolder = document.getElementById('graph-' + key);
    graphHolder.addEventListener('click', (evt) => {
      focusCard(key);
      const st = scrubState[key];
      const rect = graphHolder.getBoundingClientRect();
      const frac = (evt.clientX - rect.left) / rect.width;
      const targetPly = Math.round(frac * (st.fens.length - 1));
      if (st.playing) togglePlay(key);
      setPly(key, targetPly);
    });
    renderScrub(key);
  });
}

// arrow-key navigation drives whichever card was last touched
document.addEventListener('keydown', (evt) => {
  if (!focusedKey || !scrubState[focusedKey]) return;
  const st = scrubState[focusedKey];
  if (evt.key === 'ArrowLeft') {
    if (st.playing) togglePlay(focusedKey);
    stepBy(focusedKey, -1);
    evt.preventDefault();
  } else if (evt.key === 'ArrowRight') {
    if (st.playing) togglePlay(focusedKey);
    stepBy(focusedKey, 1);
    evt.preventDefault();
  }
});

// ---- per-tab headline stat + extra readout config ----
const TAB_CONFIG = {
  flawless: {
    score: r => r.combined_accuracy.toFixed(1), scoreLabel: 'combined accuracy',
    extra: r => `never below <span class="hl">${r.worst_my_wp.toFixed(0)}%</span><br/>rating &Delta; ${sign(r.rating_diff)}${r.rating_diff}`,
  },
  highest_rated: {
    score: r => r.opp_rating, scoreLabel: 'opponent rating',
    extra: r => `rating &Delta; ${sign(r.rating_diff)}${r.rating_diff}`,
  },
  underdogs: {
    score: r => sign(r.rating_diff) + r.rating_diff, scoreLabel: 'rating upset',
    extra: r => `you ${r.my_rating} vs ${r.opp_rating}`,
  },
  wild_rides: {
    score: r => r._wild.swings, scoreLabel: 'lead swings',
    extra: r => {
      const tacticNote = r._wild.has_tactic
        ? `incl. sac <span class="hl">${r._best_tactic.san}</span><br/>` : '';
      return `${tacticNote}dropped to <span class="hl">${r.worst_my_wp.toFixed(0)}%</span> at worst`;
    },
  },
  swindles: {
    score: r => r.worst_my_wp.toFixed(0) + '%', scoreLabel: 'lowest win prob.',
    extra: r => r.ended_in_stalemate ? 'escaped via <span class="hl">stalemate</span>'
      : (r.won_on_time ? 'won <span class="hl">on the clock</span> (opponent flagged)' : 'won from the brink'),
  },
};

// index of the deepest dip in a win% array - the scariest moment of the game
function deepestDipPly(winpc) {
  let minV = Infinity, minI = 0;
  winpc.forEach((v, i) => { if (v < minV) { minV = v; minI = i; } });
  return minI;
}

function gameCard(tab, r, rank) {
  const key = cardKey(tab, r.id);
  const cfg = TAB_CONFIG[tab];
  // Tactics-style landing: the Wild Rides tab opens on the scariest moment (the
  // deepest dip in win%), so you immediately see how bad it got. all_fens is
  // [start, after-move-1, ...] and winpc is indexed the same way, so the dip
  // index maps straight onto a position. Every other tab opens on the final
  // position.
  let startPly = r.all_fens.length - 1;
  if (tab === 'wild_rides') {
    startPly = Math.min(deepestDipPly(r.winpc), r.all_fens.length - 1);
  }
  scrubState[key] = { fens: r.all_fens, sans: r.sans, winpc: r.winpc, myColor: r.my_color,
                      glyphs: r.move_glyphs, squares: r.move_squares,
                      ply: startPly, playing: false, timer: null };

  return `<div class="game-card">
    <div class="card-top">
      <div class="rank">${String(rank).padStart(2, '0')}</div>
      <div class="card-info">
        <a href="${r.url}" target="_blank" rel="noopener">
          <div class="matchup">${colorDot(r.my_color)}you ${r.my_rating} <span class="vs">vs</span> ${r.opp_name} ${r.opp_rating}</div>
        </a>
        <div class="meta">${fmtDate(r.date)}${r.perf ? ' &middot; ' + cap(r.perf) : ''} &middot; ${r.opening || 'unnamed opening'} &middot; ${r.ply_count} plies</div>
      </div>
      <div class="card-score">
        <span class="score-num">${cfg.score(r)}</span>
        <span class="score-label">${cfg.scoreLabel}</span>
      </div>
    </div>
    <div class="card-main">
      <div class="board-wrap" data-scrub-key="${key}">
        <svg viewBox="0 0 360 360" class="board-svg" id="board-${key}"></svg>
        <div class="scrub-controls">
          <button class="scrub-btn" data-action="start" title="Start">\u23EE</button>
          <button class="scrub-btn" data-action="prev" title="Previous move">\u25C0</button>
          <button class="scrub-btn play-btn" data-action="play" id="play-${key}" title="Play">\u25B6</button>
          <button class="scrub-btn" data-action="next" title="Next move">\u25B6</button>
          <button class="scrub-btn" data-action="end" title="End">\u23ED</button>
        </div>
        <input type="range" class="scrub-slider" id="slider-${key}" min="0" max="${r.all_fens.length - 1}" value="${startPly}"/>
        <div class="scrub-label" id="label-${key}"></div>
      </div>
      <div class="stats-col">
        <div>${accBar(r.my_accuracy, r.opp_accuracy)}</div>
        <div class="readout">${cfg.extra(r)}</div>
        <div class="graph-block" id="graph-${key}"></div>
        <div class="graph-caption">win probability, move by move &middot; click to jump, \u2190/\u2192 to step</div>
      </div>
    </div>
    <a class="view-link" href="${r.url}" target="_blank" rel="noopener">View on Lichess \u2197</a>
  </div>`;
}

function renderTab(tab, list) {
  const panel = document.getElementById('panel-' + tab);
  if (!list.length) {
    panel.innerHTML = '<p class="empty-note">No games in this category yet.</p>';
    return;
  }
  panel.innerHTML = list.map((r, i) => gameCard(tab, r, i + 1)).join('');
  initScrubbers(panel);
}

renderTab('flawless', DATA.flawless);
renderTab('highest_rated', DATA.highest_rated);
renderTab('underdogs', DATA.underdogs);
renderTab('wild_rides', DATA.wild_rides);
renderTab('swindles', DATA.swindles);

document.getElementById('header-title').textContent = `${DATA.meta.username}'s best games`;
document.getElementById('meta-line').innerHTML =
  `<span class="n">${DATA.meta.games_analyzed}</span> rated standard games, no bots ` +
  `(<span class="n">${DATA.meta.wins_analyzed}</span> wins) ` +
  `&middot; ${fmtDate(DATA.meta.date_from)} \u2013 ${fmtDate(DATA.meta.date_to)}`;
document.getElementById('tab-explainer').textContent = EXPLAINERS.flawless;

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    document.getElementById('tab-explainer').textContent = EXPLAINERS[btn.dataset.tab];
  });
});

}
