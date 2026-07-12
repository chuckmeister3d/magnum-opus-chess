# ♞ Magnum Opus

**Live site: [magnum-opus-chess.netlify.app](https://magnum-opus-chess.netlify.app)**

A static website that finds anyone's best Lichess games and shows them as an interactive report: five ranked tabs, a scrubbable board for every game. Someone types their username, picks a date range, and gets their report.

**The key idea:** all the chess analysis (including Stockfish) runs *in the visitor's own browser*. That means:

- **Free to host** — it's just static files (HTML/JS/WASM). GitHub Pages, Netlify, or Cloudflare Pages all host it for $0.
- **Full Stockfish coverage** — games the visitor never analysed on Lichess get evaluated locally, on their CPU.
- **Scales to anyone** — every visitor brings their own compute, so a thousand users cost the same as one.

This is the same approach lichess.org itself uses for in-browser analysis.

## The five tabs

- **Flawless** — clean wins: no real blunders either side, never actually losing.
- **Highest-Rated Wins** — the strongest opponents beaten.
- **Biggest Underdogs** — widest rating-gap wins.
- **Wild Rides** — games where the eval see-sawed wildly before the win.
- **Swindles** — losing for a sustained stretch, then still winning (or escaping by stalemate).

## Try it locally

You need any static file server (the browser blocks ES modules over `file://`):

```bash
cd site
python3 -m http.server 8000
# open http://localhost:8000
```

Type a Lichess username, choose all-time or a date range, and go.

## The example report

`site/example.html` is a ready-made report, linked from the front page ("See an
example report") so visitors can preview the output before running anything. The
bundled one is a real report for the account `chuckmeister3d`. To feature someone
else — Magnus Carlsen, say — run the site once for `DrNykterstein`, then save the
resulting report over `site/example.html`.

## Deploy it (free)

**Netlify (easiest):** drag the `site/` folder onto https://app.netlify.com/drop — done. The included `netlify.toml` sets the right headers automatically.

**GitHub Pages:** push `site/`'s contents to a repo, enable Pages on the branch. (Pages ignores the `_headers` file, but the bundled single-threaded Stockfish doesn't need special headers, so it still works.)

**Cloudflare Pages / Vercel:** point them at the `site/` folder; both read `_headers`.

## How it's built

Plain ES modules, no build step, no framework. Each file does one job:

| File | Role |
|------|------|
| `index.html` | The page: input form, progress, consent dialog, report container |
| `main.js` | Controller: fetch → parse → analyse → engine-eval → render |
| `pgn.js` | Parses PGN and fetches games from the Lichess API (browser → Lichess) |
| `analysis.js` | The scoring engine — a faithful port of the Python `core.py`, every threshold identical |
| `engine.js` | Stockfish (WASM) in Web Workers; runs several in parallel |
| `render.js` | The report UI — tabs, board scrubber, win% graph, glyphs |
| `vendor/` | chess.js (move parsing) + Stockfish WASM (the engine) |
| `assets/pieces.json` | The cburnett chess piece SVGs, embedded |

### Parallelism

`engine.js` spins up multiple Stockfish Web Workers (defaults to the visitor's core count minus one) and feeds them games from a shared queue — near-linear speedup with cores, all on the visitor's machine.

### The time estimate

Before analysing un-evaluated games, the site benchmarks Stockfish on the visitor's actual device, then shows a real estimate and asks for consent. They can analyse everything, cap it to the most recent N games, or skip and use only their Lichess-analysed games.

## What's verified

Analysis pipeline (offline, reproducible with just Node — no network, no browser):

- `npm test` runs the real `pgn.js` parser and `analysis.js` scorer/ranker over a known game and checks **both** the stored-eval and engine-eval paths (23 assertions, all passing).
- **The JS analysis produces identical results to the validated Python** — same games surface in every tab, same accuracy numbers.

In a real (headless Chrome) browser, from earlier runs:

- Page renders, all ES modules load.
- PGN parser handles real Lichess exports (850-game file parsed correctly).
- Stockfish WASM initialises (`uciok`) and returns correct evals (`score cp 127`, parsed right).
- The full report renders with working tabs, board scrubber, and graph.

### Fixed in this pass

The Lichess fetch previously sent `analysed=false`. On the Lichess API that is a
*filter* meaning "only games **without** a computer analysis", so it silently
dropped every game you'd analysed on Lichess — exactly the ones scored instantly
from stored evals. The parameter is now omitted, so the fetch returns all games
and `evals=true` still attaches stored evals where they exist. This was never
caught before because the live fetch had never actually been run — validation
used a saved PGN.

The in-browser Stockfish was also hardened: search depth for locally-evaluated
games is now **10** (WASM is ~100× slower than the desktop tool's native engine,
so 12 was impractically slow — games Lichess already analysed keep their own
deeper evals, so this only affects the minority you never analysed). The engine
now shows real per-position progress, times out instead of hanging if a search
wedges, skips terminal positions without searching, and — if the engine can't
start at all — the report still renders from your Lichess-analysed games. An
illegal (kingless) benchmark position that could make Stockfish never return was
also removed.

**Root-cause fix (verified live in a real browser):** the engine init sent
`setoption name Threads value 1`. On this single-threaded WASM/asm.js build (no
`SharedArrayBuffer`) that command *wedges the engine* — it never returns
`readyok`, so every run timed out and fell back to showing only Lichess-analysed
games (empty tabs). The line is gone; the engine now initialises and evaluates
normally (~0.1 s per position at depth 10, e.g. 43 games ≈ 20 s on 14 workers).
As a fallback it also tries the asm.js build if the WASM one ever won't start,
and logs `MO:`-prefixed diagnostics (toggle `DBG` in `engine.js`).

**Flawless** now also requires that you were genuinely *winning* at some point
(win% reached ≥ 65), not merely never losing. This stops dead-even games that
were won on time or by resignation — where you never actually held an
advantage — from showing up as "flawless" wins.

The download is now **more informative and feels faster**: it shows `X of ~Y
games` (the total is estimated from your Lichess profile) and the progress bar
tracks the download across most of its length instead of jumping. Raw download
speed is capped by Lichess itself (≈20 games/second anonymously); the input form
has an optional **API token** field that raises this to 30/s, or 60/s for your
own games. The token is used only to call Lichess and never leaves the browser.

The progress view is now **three explicit stages**, each with its own bar —
download, benchmark (which shows the time estimate), then analyse after you
confirm — instead of one bar that jumped around. The front page also links a
ready-made **example report** so visitors can see the output before running.

## Testing on your machine

Two things can only be confirmed on a networked, multi-core machine:

1. **Live fetch.** `cd site && python3 -m http.server 8000`, open
   <http://localhost:8000>, type a real Lichess username, choose a **narrow date
   range first** (fast), and confirm games download and the report renders. The
   API sends `Access-Control-Allow-Origin: *`, so the cross-origin fetch is
   allowed.
2. **Engine throughput.** Then try "all time" so un-analysed games run through
   browser-Stockfish. Watch the time estimate and the parallel workers, and tune
   the defaults if you like: worker count is `cores − 1` (in `main.js`) and the
   consent dialog suggests a 300-game cap.

Quick check of just the analysis logic, no browser needed: `npm test`.

## Credits

Chess pieces: **cburnett** by Colin M. L. Burnett (GPLv2+ / CC BY-SA), via Lichess.
Engine: **Stockfish** (GPLv3), the `stockfish.js` WebAssembly build by Niklas Fiekas.
Move parsing: **chess.js** (BSD-2-Clause).
Accuracy/win% math mirrors Lichess's own formulas.

Full attributions and source links are in [`CREDITS.md`](CREDITS.md).

## License

Magnum Opus (the website) is © 2026 Charles Davison and released under the
**GNU General Public License v3 or later** — see [`LICENSE`](LICENSE). The site
is GPLv3 as a whole because it bundles GPL'd Stockfish and the cburnett pieces;
the original scoring, analysis, and UI code is the author's own. Keep `LICENSE`,
`CREDITS.md`, and the footer attributions with any copy you redistribute.
