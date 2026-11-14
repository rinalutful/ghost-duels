# 0009: Ghosts are committed before their cave exists; kept stakes grow the pot

Supersedes the minting and payout parts of [0006](0006-the-economy.md).

## Context

v1 minted a ghost *after* its run was verified: `mint_ghost(run, log, pot, stake)` from any practice
run or won challenge. A minter (person or bot) could fly 30 caves free and mint only the best, a
ghost the same bot beats 2.4% of the time (0008). And a ghost's record ("held 20, earned 1.9 NEAR")
could be bought for 5% of it: the owner's second account loses on purpose, and 95% of each stake
comes straight back (the AI judge's finding 3).

## Decision

- **A qualifier is declared at `start_run(qualify: {pot, stake})`**, before the seed is drawn. The
  pot leaves the balance then. If the replayed score reaches `min_ghost_score`, the run becomes a
  ghost in the same settlement, with that pot; there is no `mint_ghost`. If it falls short, is
  refused, or expires, the pot comes back minus `abandon_bps` (20%, to the house).
- **A ghost's pot is locked for `pot_lock_secs`** (a day) after it was minted, refilled or grew:
  `retire_ghost` refuses until then. A weak ghost can't be minted and quietly withdrawn.
- **A kept stake is split three ways**: `rake_bps` (5%) to the house, `pot_bps` (25%) into the
  ghost's pot, the rest (70%) to its owner. The jackpot grows with every failed challenge, which
  gives popular ghosts a reason to be raced; and a faked defence locks a quarter of its stake where
  any challenger can win it.
- **Only a replayed loss is a defence.** A refused or expired challenge still pays, but counts as a
  forfeit. The record also keeps the closest call (the best challenger score), what the pot grew,
  and the rake paid. The NFT's description prints them: "faking this record would have cost at least
  that rake plus the growth left at risk in the pot".
- Rake and pot share are fixed into the run at `start_run`, so a later `set_params` can't change a
  run in flight.

## Consequences

- 20 fake defences of a 0.1 NEAR stake now cost the pair 0.1 NEAR of rake and lock 0.5 NEAR in the
  pot for a day, and the record reads "closest call 7" (`attack_wash_trade_shows_its_cost`).
- A best-of-k ghost costs 0.2·(k−1) pots in abandon fees (0008's table).
- A won challenge no longer becomes a ghost by itself: the winner flies a qualifier.
- The owner's share per loss drops from 95% to 70%; the 25% stays theirs in the pot unless someone
  beats the ghost.
