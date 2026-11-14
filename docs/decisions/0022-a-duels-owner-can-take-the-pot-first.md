# 0022: A duel's owner can take the pot before a winner lands: stated on v4, not fixed there

Corrects one sentence of [0015](0015-any-number-may-race-a-ghost.md). Tracking: #30.

## Context

0015 removed the lock on a ghost: any number may race it, the first challenger to beat it takes
the pot, and a later winner whose run was already in flight gets the stake back. It also said
`retire_ghost` waits for runs in flight, "so an owner can't pull the pot from under a winner's
pending submit". That sentence is true of `retire_ghost` and false of the owner.

A review on 2026-11-10 showed the other way out. Since 0019 a staked ghost is a private duel, and
its owner chooses who may race it. `set_challengers` is not refused while a race is in flight. So:

1. bob, a named challenger, starts a race (the ghost shows `racing: 1`).
2. The owner names a second account of their own (or named it when the ghost was minted).
3. That account starts a run. A program flies it: it needs a few seconds, not a minute, and a
   bot beats a human's ghost almost always (0008). It submits and takes the pot.
4. bob lands a winning run inside his deadline. Settlement finds the pot empty: "beat ghost #N,
   but its pot was already won; the stake comes back".

When bob loses, the owner keeps 70% of his stake as usual. So an owner willing to do this cannot
lose the pot: bob can lose his stake, and can win nothing. The unit test
`limit_a_duel_owner_can_take_the_pot_before_a_winner_lands` shows it on the v4 source.

## Decision

- **v4 keeps this, and says so.** v4's account has no keys (0020), so its code can't change. The
  README's limits, JUDGES.md's "not claimed" and this record state it. The README no longer calls
  the contract "the referee nobody has to trust" for duels without this caveat: the contract
  referees the *score* (nobody can claim a score they didn't fly), not the *pot's availability*
  against the ghost's owner.
- **What a duel on v4 is, then:** a bet between people who chose each other, where the challenger
  trusts the owner not to do the above, and can see afterwards if they did (the winning run, its
  account and the list change are all on chain, and the ghost's `beaten` count goes up).
- **The fix is a contract change, so it is a new version** (a `v5` branch of this repo): a duel takes
  one challenge at a time (a lock is safe here because only accounts the owner named can hold it,
  which is what 0015's hostage attack lacked), and `set_challengers` is refused while a race is in
  flight. Deploying it needs a new account and is the owner's decision.

## Consequences

- The test is named `limit_…`, not `attack_…`, and is not counted among the attacks refused.
- The public ladder is unaffected: no pot.
- 0015's decision (no lock on a ghost anyone may race) stands for v4; only its claim about the
  owner is corrected.

## Closed in v5 by 0023

The new version is [0023](0023-a-duel-takes-one-race-at-a-time.md). This record stays true of v4.
