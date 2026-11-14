# 0025: The page does one thing at a time

Tracking: #30.

## Context

The page's screens are driven by async answers: a board read, a start, a submit, an owner's
transaction. Each continuation used to draw its screen when it landed, whatever was on screen by
then. A mocked-chain pass in the page test (`demo/src/mockchain.ts`, which holds a transaction
pending) found the results: two `start_run` from a double click, the title drawn over a pending
start, a staked race abandoned from the board's Watch, a result card landing over the next run, a
form wiped by a board read.

## Decision

`web/src/main.ts` follows three rules, and new code should too:

- **One chain action at a time.** While a start, a submit or an owner's transaction is pending
  (`waiting`), or a real race is in flight, nothing new starts: `blocked()` refuses and says why.
  Free things (Watch, a practice race) wait only for a real race and a pending race card. A real
  race shows its pending card from the click, so there is nothing left to click twice.
- **An answer for an old screen is dropped.** `shown` counts screens (`show()`, `begin()`); an async
  continuation compares the count it started with before it draws.
- **Background reads don't take the screen.** A board read redraws the title only if the title is
  showing (`retitle`), or if nothing replaced the screen a link was opened over (opening a link is
  the player's own step, so it may replace a result card or the Fly form); never over a run or a
  pending race card. It draws the board only when no inline form is open; only the newest read
  draws.

## Consequences

Clicks during a pending transaction get a status line instead of an action. A slow RPC keeps the
pending card up with no way out until `send()` gives up (minutes, at worst); that is unchanged.
The page test's last pass checks each rule (`npm run page-test`).
