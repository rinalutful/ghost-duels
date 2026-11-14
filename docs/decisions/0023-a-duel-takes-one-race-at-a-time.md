# 0023: v5: a duel takes one race at a time; its list can't change mid-race; a failed withdrawal comes back; a qualifier commits its recording's storage at the start

Amended by [0024](0024-a-staked-start-names-the-pot-it-was-shown.md): `retire_ghost` still closes
a stale race itself, but reads the pot lock after that forfeit, so that retire is refused and the
race is closed by `expire_run`, the next start or `set_challengers` instead.

Closes the limit [0022](0022-a-duels-owner-can-take-the-pot-first.md) stated. Amends
[0015](0015-any-number-may-race-a-ghost.md) for staked ghosts. Tracking: #30.

## Context

0022: on v4 a duel's owner can name a second account while a challenger is in flight and have it
win the pot first, because any number may race a ghost at once (0015) and the first to settle
takes the pot. The challenger can lose a stake and can never win the pot.

0015 removed the lock on a ghost because it was a weapon when *anyone* could take it: a
stranger's fresh accounts held a ghost for an hour. Since 0019 only accounts the owner named can
race a staked ghost, so a lock on a duel can only be held by someone the owner chose.

Two alternatives were weighed and dropped:

- *Pay the pot by start order* (a later-started winner gets the stake back while an earlier race
  is in flight). It stops the rescue, but an owner's second account that starts first shields the
  pot just the same, and the honest challenger flies a whole race to find out. A lock says it
  before the stake is locked.
- *Fly the ghost's own cave in a duel*, which would also make the race read as one track. Then a
  challenger rehearses the exact cave as often as they like, free, before staking once, while the
  ghost's owner flew it blind; and "the stake is locked before the cave exists" (0002, 0009), which
  is what stops fishing for a lucky cave, would no longer hold for challenges. Kept as it is; the
  page now says at the countdown that you fly your own cave and the ghost shows its pace.

## Decision

- **A staked ghost carries `lock_run`: its one race in flight.** `start_run` against a duel sets
  it and is refused while it is set ("a duel takes one race at a time"). Settling or expiring that
  run clears it. The public ladder is unchanged: any number race a ladder ghost at once.
- **A race that was never submitted holds the duel only until its deadline.** The next
  `start_run`, `set_challengers` or `retire_ghost` that needs the ghost closes it itself, as
  `expire_run` would (a forfeit that pays the ghost). Nobody needs a separate transaction.
- **`set_challengers` is refused while a race is in flight**, and nobody may name themselves (in a
  qualifier or in `set_challengers`).
- With one race at a time a duel's pot can't be won twice, so settlement's "its pot was already
  won; the stake comes back" branch is gone.
- **`withdraw` has a callback.** If the transfer fails (the account was deleted before the NEAR
  arrived), `on_withdraw` credits the amount back to the balance it left. v4 dropped it.

- **A qualifier's reserve holds its recording's storage from `start_run`** (`GHOST_LOG_BYTES`, the
  longest log a ghost can keep: 0.083 NEAR, refunded as far as the submitted log is shorter). v4
  took it at submit, so a player whose balance was close to the pot flew a good run, was refused,
  and forfeited 20% of the pot when the run expired (#34; it happened to a demo player). Everything
  a run can need is now committed before its cave exists, like the stake and the pot (0009).

## Consequences

- What 0022 described is refused three ways: the list can't change mid-race, an account named in
  advance can't start while the challenger races, and the ghost can't be retired
  (`attack_owner_cannot_take_the_pot_from_under_a_racing_challenger`). Also
  `attack_two_challengers_cannot_race_a_duel_at_once`, `a_stale_race_is_closed_by_the_next_challenger`,
  `a_failed_withdrawal_comes_back_to_the_balance`, `a_qualifier_that_can_start_can_always_submit`;
  seven mutants in `demo/mutants.ts`.
- **What it costs: an owner can keep their own duel busy.** A second account they named can start
  races it never submits; each holds the duel for up to 90 s and costs them the rake and the pot
  share of a stake (`attack_holding_a_duel_needs_a_named_account_and_costs_every_time`, counted as
  priced, not refused). The invited player can't race meanwhile and loses nothing. That is the
  trade against v4, where the invited player could pay stakes into a duel they could never win.
- An owner's second account can still win the owner's own pot when nobody is racing. That is the
  owner taking their own money back early (the pot lock is a day); nobody else's money is involved.
- In Runner or OutLayer mode a submitted run holds the duel until its replay returns or
  `expire_run` settles it after the timeout; only an unsubmitted run is closed automatically.
- The state layout changed (`Ghost.lock_run`), so v5 is a new account. v4 stays as it is, with its
  limit stated. `res/deploy.json` names the live deploy; `npm run deploy-v5` makes v5 and rewrites it.
