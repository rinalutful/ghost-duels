# 0016: A refill only restores the pot a ghost qualified with; kept stakes' pot share goes to the house on retire

Amends [0009](0009-ghosts-are-committed-before-the-cave.md) and the best-of-k figures in
[0008](0008-a-bot-needs-only-the-screen.md).

## Context

The AI judge's second round found two ways around 0009:
- **Best-of-k was nearly free.** Qualify at the minimum pot (0.01 NEAR), throw away 29 caves at 20%
  of that (0.153 NEAR in all), then `refill_ghost` the keeper to 2 NEAR at once. 0008's "a best-of-k
  ghost costs 0.2·(k−1) pots" priced the tries at the small pot, not the one the ghost ends up with.
- **Wash trading came home.** The 25% pot share of a faked defence stayed the owner's: after the
  day's lock, `retire_ghost` returned it. 20 faked near misses ("closest call 302") cost 0.207 NEAR.

## Decision

- A ghost records `qualified_pot`. `refill_ghost` may bring the owner's part of the pot back up to
  it, never past it. A ghost with a big pot must have risked that pot on its qualifier, so 0008's
  formula now holds with P = the pot the ghost carries: a best-of-k ghost costs 0.2·(k−1)·P.
- A ghost records `grown_in_pot`, the part of its pot that came from kept stakes. A challenger who
  beats it takes all of it; if the owner retires the ghost, that part goes to the house. A faked
  defence therefore costs at least the rake plus the pot share, 30% of the stake, and the NFT prints
  that number.
- "Closest call" is no longer offered as evidence (a bot can fake a near miss): it is the best
  losing score, nothing more.

## Consequences

- `attack_cheap_qualifier_then_refill_is_refused`; `attack_wash_trade_near_misses_cost_what_the_record_says`
  (20 fakes now cost the pair at least 0.6 NEAR, was 0.207).
- An owner who wants a bigger pot flies a new qualifier.
- A record can still be bought; its price is now stated on the token and is what it says.
