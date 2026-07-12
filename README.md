# ♞ Magnum Opus

**Live site: [magnum-opus-chess.netlify.app](https://magnum-opus-chess.netlify.app)**

A website that finds your best Lichess games and shows them as an interactive report: five ranked tabs, a scrubbable board for every game. You type your username, pick a date range, and get your report.


<img width="715" height="768" alt="Screenshot 2026-07-12 at 10 24 30" src="https://github.com/user-attachments/assets/1eb99c2e-8559-45b1-8019-ceda6e850681" />


**The key idea:** all the chess analysis (including Stockfish) runs *in the visitor's own browser*. That means:
This is the same approach lichess.org itself uses for in-browser analysis.

## The five tabs

- **Flawless** — clean wins: no real blunders either side, never actually losing.
- **Highest-Rated Wins** — the strongest opponents beaten.
- **Biggest Underdogs** — widest rating-gap wins.
- **Wild Rides** — games where the eval see-sawed wildly before the win.
- **Swindles** — losing for a sustained stretch, then still winning (or escaping by stalemate).


  <img width="715" height="768" alt="Screenshot 2026-07-12 at 10 35 58" src="https://github.com/user-attachments/assets/44ebb6ef-a1c6-493f-962d-888eea4222d7" />
  

## Try it locally

You need any static file server (the browser blocks ES modules over `file://`):

```bash
cd site
python3 -m http.server 8000
# open http://localhost:8000
```
Type a Lichess username, choose all-time or a date range, and go.

## Structure

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
