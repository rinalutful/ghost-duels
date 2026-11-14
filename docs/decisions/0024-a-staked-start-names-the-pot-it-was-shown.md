# 0024: v5: a staked start names the pot it was shown; retire closes a stale race before it reads the pot lock

Adds to [0023](0023-a-duel-takes-one-race-at-a-time.md), before v5's first deploy. Tracking: #30.

## Context

Two findings of the last review before v5 is deployed, both reproduced on the committed v5 build
(`res/ghost_duels.wasm` at `1054cff`) in the Node host:

- **A duel's pot is the one term that can change after a challenger has read it.** The stake and
  the score to beat are fixed at mint. The pot is not: an account the owner named (a second
  account of theirs counts) wins it, and `refill_ghost` restores as little as the stake. 0023
  keeps the pot in place *during* a race; nothing held it between the challenger reading the board
  and their `start_run` landing. A challenger shown "1 NEAR pot, 0.1 stake" could have their start
  land on a 0.1 pot and risk the same stake for a tenth of the prize. `start_run` already lets a
  player refuse a fee (`max_fee`) and a qualifier refuse the owner's terms (`max_min_score`,
  `max_abandon_bps`); a challenge had no such word about the pot.
- **`retire_ghost` read the pot lock before it closed a stale race.** A kept stake grows the pot
  and locks it for `pot_lock_secs` (0006). `retire_ghost` expires a race past its deadline itself
  (0023), and that forfeit is growth, but the lock had been checked a line earlier: the same call
  retired a pot that had just grown. No money went to the wrong account (the grown part of a
  retired pot is the house's either way); the stated rule "not within a day of growth" didn't hold
  on this one path.

## Decision

- `start_run` takes `min_pot: Option<U128>`. For a challenge it is refused, before anything is
  staked, if the ghost's pot is below it. Omitted: as before. The page sends the pot it showed,
  reads the ghost again just before a staked start, and asks before racing for a smaller pot.
- `retire_ghost` calls `expire_stale_lock` first and checks the pot lock on the ghost as it is
  after that. A retire that meets a stale race is refused as a whole (the expiry is not kept);
  `expire_run`, or the next start, closes the race, and the pot is retirable a day later.
- Not `min_pot` enforced by default (a start with no `min_pot` refused): scripts and the session
  flow that don't read the board would break for no gain, and the ladder has no pot.

## Consequences

- `attack_a_pot_swapped_for_a_smaller_one_is_refused_by_min_pot`,
  `a_forfeit_closed_by_retire_locks_the_pot_like_any_other_growth`; a core-loop check; two contract
  mutants and one page mutant in `demo/mutants.ts`.
- The live v4 ignores the extra argument (near-sdk drops unknown JSON fields; checked on
  `res/v4/ghost_duels.wasm`), so the same page works against both; on v4 only the page's re-read
  protects a challenger, and a front-run between that read and the start is still possible there.
- An owner who presses Retire over a stale race gets "locked until", and since the refused call
  keeps nothing, the race is still open: `expire_run`, the next start, or `set_challengers` (which
  closes it and has no lock check) is the way on. Stated in the README's limits. Not worth another
  build: nobody's money waits on it but the owner's own, for a day they would wait anyway.
- A caller that doesn't send `min_pot` has no protection: the argument is the challenger's to use.
- The wasm changed (356,413 bytes); nothing was deployed from the earlier v5 build.
