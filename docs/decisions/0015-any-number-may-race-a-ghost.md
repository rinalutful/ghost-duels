# 0015: Any number may race a ghost at once; the first to beat it takes the pot

Supersedes "one challenger at a time" in [0006](0006-the-economy.md).

## Context

v1 and v2 locked a ghost while one challenger raced it, so its pot couldn't be paid twice. The AI
judge's second round showed the lock was a weapon: the owner's second account re-locks the ghost
the moment each lapsed lock frees, and kept 40 of 40 real challengers out for an hour at a cost of
0.44 NEAR. Cooldowns per account don't help against fresh accounts.

## Decision

- No lock. `start_run` on a ghost only counts it in `racing`. Settlement reads the pot as it is at
  that moment: the first challenger to beat the ghost takes the pot; a later winner whose run was
  already in flight gets the stake back ("its pot was already won"); losers pay as before.
- `retire_ghost` waits until no challenge is in flight (anyone can `expire_run` the ones past their
  deadline), so an owner can't pull the pot from under a winner's pending submit.

## Consequences

- Holding a ghost hostage is impossible (`attack_relocking_a_ghost_never_blocks_a_challenger`).
- Two challengers who both beat a ghost race to settle first; the second is refunded, not paid.
- The page shows "N racing now" and keeps the Race button.

## Corrected by 0022 (2026-11-10)

"So an owner can't pull the pot from under a winner's pending submit" holds for `retire_ghost`
only. A duel's owner can name a second account while a race is in flight and have it win first;
see [0022](0022-a-duels-owner-can-take-the-pot-first.md).

## Amended by 0023 (v5)

In v5 a staked ghost (a duel) takes one race at a time again; the public ladder keeps this
record's rule. See [0023](0023-a-duel-takes-one-race-at-a-time.md).
