# 0021: The page is the game: ink on paper, the title flies a real ghost, the board draws real flights

## Context

2026-11-10: the page should look less like generated UI and be easier to use for someone who
gives it a minute. The games track gives a bonus "if players never notice the chain".

The page before was dark navy with cyan, monospace everywhere, a centred title over an empty starfield
and a sidebar of ghost cards whose text led with pots, stakes and account ids. A visitor saw the
chain before the game.

## Decision

- **The play area is the first screen.** Behind the title card the canvas flies the featured ghost's
  recorded run on its own cave (attract mode), labelled as such; before the board loads, or with no
  network, a simple autopilot flies instead, with no label. The primary button is a free race against
  that ghost; Practice and Play for real sit beside it.
- **Ink on paper, two corners.** Paper and ink, signal orange for you, blue for the ghost; nothing
  else. Bungee (a caps-only signage face) for the arcade voice, Atkinson Hyperlegible Next and Mono
  for reading, self-hosted. Trails are the signature: yours a line, the ghost's dots.
- **The board is a race board.** Each ghost's lane is its flight: its log fetched once
  (`get_ghost_log`, cached in localStorage by log hash, used only if its seed matches the ghost's),
  replayed in a third sim instance, drawn to where it crashed. Logs are fetched only for rows near the
  viewport, one at a time, 250 ms apart, because the public RPC rate-limits. Until a log arrives the
  lane is a dotted line to the crash, from the ghost's own `ticks`.
- **Chain details are one click away, not first**: the contract, the explorer and the submitted
  payload are under "How the score is checked"; transactions appear as "see the transaction" where
  money moved. Money appears where the player decides to stake.
- **Phones**: the card and a "hold to climb" pad sit under the screen inside the frame, so a thumb
  doesn't cover the ship. `touch-action: none` is on the canvas and the pad only, so the card scrolls.

## Consequences

- The title and the board make more view calls than before (one log per visible ghost, once per
  browser). A 429 from the RPC would show as a console error in `npm run page-test`'s live pass; the
  spacing and the viewport limit keep it to a handful.
- Bungee has no lowercase, so headings are written in the case they should read in; CSS
  `text-transform` would change what `innerText` (and the page tests) see.
- No contract call, rule (`web/src/rules.ts`) or flow changed; the page test passed 26/26 without
  edits. `web/src/main.ts`, `web/src/style.css`, `web/index.html`; `npm run screenshots` captures the
  states (`docs/screenshots/`).

Edited 2026-11-10: internal process wording removed from the context; the decision is unchanged.
