# 0013: v2 is deployed to a new account, in on-chain mode

## Context

v2 changes the contract's state layout (new fields on runs, ghosts and config, a key-cap map), so it
can't replace the code at `duels.ghost-duels-jbx5v9.testnet` in place, and tonight's rules forbid
touching a live contract anyway. 0004 measured that the contract can replay a full run for about
1.3 Tgas, and 0003 left the choice of lead mode to the owner.

## Decision

- v2 goes to a new account; v1 stays as it is, with its ghosts and history, linked from the README.
- v2 runs in **OnChain** mode. A run settles in the player's own `submit_run`, with no runner
  process that must be online, no fee, and nothing trusted but the chain. Runner and OutLayer stay
  built and tested (sandbox and unit tests) for sims too heavy for one call.
- The web page, `npm run verify`, `npm run session` and the demos point at the new account.

## Consequences

- The owner's "pick the lead mode" question is answered for v2 (he can still `set_mode`).
- The page's old v1 ghosts aren't on v2; the demo mints fresh ones.
