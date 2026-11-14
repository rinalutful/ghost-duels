# 0018: Qualifiers can refuse the owner's terms; no race below the stake; the cap counts losses; no price on a fake record

Amends [0016](0016-a-ghost-pot-is-what-it-qualified-with.md) (its price claim) and [0017](0017-a-key-cap-covers-storage.md).
Fixed in source; **not deployed**: v3 has no keys, and a locked v4 needs ~3.4 NEAR that its funder
doesn't have (2.1 left). Issue #18.

## Context

Our own AI review's third round found:
- The owner could raise `min_ghost_score` just before a qualifier started and collect its abandon
  fee (a run keeps the terms it *started* with, but it didn't choose them).
- A beaten ghost whose pot regrew from an in-flight loser's stake (0.025 NEAR) could be raced at a
  0.1 stake.
- The refundable settlement reserve counted against a key's cap, so a 0.5 cap ran out after a few
  small losses.
- 0016's claim that a faked defence costs at least 30% of the stake was false: the owner's alt can
  beat the ghost and take the grown pot back, net 0.214 NEAR for 20 fakes.

## Decision

- `Qualify` takes optional `max_min_score` and `max_abandon_bps`; `start_run` refuses if the owner's
  current terms exceed them, as `max_fee` does for the fee. `set_params` caps `min_ghost_score` at 1000.
- `start_run` refuses a ghost whose pot is below its stake.
- A key's cap counts stake, pot, fee and the run's storage; not the reserve, which comes back.
- The token no longer prices a fake. It says a record can be faked from a second account and proves
  runs were flown and paid for, not who flew them. Sending the pot share to the house on a win by a
  "linked" account would need a definition of linked that sybils can't dodge; we don't have one.

## Consequences

- Tests `attack_owner_cannot_confiscate_a_qualifier_with_its_terms`, `attack_ghost_with_pot_below_stake_cannot_be_raced`,
  `attack_key_cap_counts_losses_not_the_refunded_reserve`; four more mutants (30/30).
- `res/ghost_duels.wasm` is this source's build; `res/v3/ghost_duels.wasm` is what v3 runs, and
  `npm run verify` checks v3 against it.

Edited 2026-11-10: a quoted dry-run score removed.
