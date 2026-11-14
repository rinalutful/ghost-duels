# 0012: No run is voided: a replay that fails is done on-chain

Supersedes the void-and-refund rule of [0003](0003-three-replay-modes-one-settle.md) and [0006](0006-the-economy.md).

## Context

v1 refunded the stake whenever a replay failed or timed out. A player knows their score before
submitting, so a loser had a reason to want a void: in Runner mode anyone could call `expire_run`
once the runner was late, and a failed OutLayer job did the same. v1 also set `fee_spent` before
calling `request_execution`, so a failed call stranded the fee in the contract.

## Decision

- Off-chain modes store the submitted log (paid by the player, 0011) until the run settles.
- If the runner doesn't answer within `replay_timeout_secs`, anyone's `expire_run` replays the stored
  log **on-chain** (about 1.3 Tgas, 0004) and settles it. If OutLayer answers null, garbage, or a
  result for a different log, `on_replay` does the same right there. The loss stands.
- If `request_execution` itself fails, its attached fee comes back to the contract; `on_replay`
  marks it unspent and the player gets it back at the end of the run. Any fee nobody earned (an
  on-chain replay) is refunded too.

## Consequences

- There is no `Voided` status any more, and no way to buy a retry by making the replay fail.
- `via` says "on-chain fallback (why)" for these runs.
- A runner that lies is still trusted in Runner mode (it can't replay a different log); OnChain
  mode, the v2 deploy's, has no runner at all (0013).
