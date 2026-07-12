# Credits & licenses

Magnum Opus (the website)
Copyright (C) 2026 Charles Davison

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU General Public License, version 3** (or, at your option,
any later version) as published by the Free Software Foundation. See the
[`LICENSE`](./LICENSE) file for the full text.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See the GNU General Public License for more details.

The site is licensed as a whole under the GPLv3 because it bundles GPL-licensed
components (the Stockfish engine and the cburnett piece set). The original
scoring, analysis, and UI code is the author's own work.

## Bundled components

| Component | Files | License | Source |
|-----------|-------|---------|--------|
| **Stockfish** chess engine (WebAssembly build) | `site/vendor/stockfish.js`, `site/vendor/stockfish.wasm`, `site/vendor/stockfish.wasm.js` | GPL-3.0 | Engine: <https://github.com/official-stockfish/Stockfish> · variant source used for this build: <https://github.com/ddugovic/Stockfish> · WASM/JS build by Niklas Fiekas: <https://github.com/niklasf/stockfish.js> |
| **cburnett** chess pieces | `site/assets/pieces.json` (embedded SVGs) | GPL-2.0-or-later / CC BY-SA 3.0 | By Colin M. L. Burnett, as used by Lichess and Wikipedia: <https://github.com/lichess-org/lila/tree/master/public/piece/cburnett> · <https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces> |
| **chess.js** move generation/parsing | `site/vendor/chess.js` | BSD-2-Clause | By Jeff Hlywa: <https://github.com/jhlywa/chess.js> |

## Loaded at runtime (not distributed with this project)

| Component | License | Source |
|-----------|---------|--------|
| Fonts: Fraunces, Work Sans, Space Mono (served from Google Fonts) | SIL Open Font License 1.1 | <https://fonts.google.com/> |

## Corresponding Source (GPL compliance)

The Stockfish engine is conveyed here in object-code form (WebAssembly). Its
complete Corresponding Source is publicly available, free of charge, at the
Stockfish source repositories linked in the table above. The bundled engine is
an **unmodified** build of Niklas Fiekas's `stockfish.js`. If you redistribute
this site, keep this file and `LICENSE` alongside it so recipients can obtain
the source.

## Attributions in the app

The report footer credits the cburnett pieces and Stockfish. Please keep that
footer intact when redistributing.

## Formulas

Accuracy and win-percentage math mirror Lichess's own published formulas:
<https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala>
