# 0019: Staked play is a private duel between players who chose each other; the public ladder moves no money

## Context

Replay proves a score was flown from the submitted inputs, not who flew them, and a bot that sees
only the screen flies a median 2461 against our human model's 281 (0008). On v3 anyone could stake
against any open ghost, so in staked play against strangers a bot takes almost every human ghost's
pot (99.8%), and a bot ghost takes human challengers' stakes. A humans-only ladder (proof of
personhood or device attestation, issue #13) isn't available on testnet in a form the contract can
check. Every judge read this as the reason the entry's utility was low (issue #21).

## Decision

- **A ghost with a pot and a stake is a private duel.** Its qualifier names 1 to 16 challengers
  (`Qualify.challengers`), and `start_run` refuses anyone else: "this ghost is a private duel and its
  owner hasn't named you". The owner chose them; each challenger chooses the ghost by starting a run
  against it. The owner can replace the list (`set_challengers`; an empty list closes the duel), and
  a ghost passed to someone else keeps the list its challengers chose to race until the new owner
  changes it.
- **Naming who may race your money takes your full-access key** (1 yoctoNEAR on the staked qualifier
  and on `set_challengers`). A session key can race the duels its account was named in, and fly
  public qualifiers, but a stolen one can't name the thief.
- **A ghost with no pot and no stake is on the public ladder.** Anyone races it (a session key too),
  the record counts (defences, beaten, the best losing challenge), and no money moves: no stake, no
  pot, no rake, nothing to refill. It names nobody.
- The economy inside a duel is unchanged (0009, 0015, 0016): 70% of a kept stake to the ghost's
  owner, 25% into its pot, 5% to the house; a win takes the pot.

## Consequences

- Bots aren't stopped; they are kept out of other people's money. A bot can top the public ladder,
  and a friend you name can still use one: the contract can't tell, and the README says so. What a
  duel proves is that the score was flown from the inputs, by an account you chose.
- A lone visitor can't stake against a stranger any more. The page's staked race takes two players
  (two browsers will do): one names the other, the other races. The public ladder is the one-person
  flow.
- Tests: `attack_stranger_cannot_race_a_private_duel`, `attack_guest_sybils_cannot_reach_staked_play`
  (20 guest accounts with capped keys), `attack_mutual_choice_bypasses_are_refused`,
  `public_ladder_counts_the_record_and_moves_no_money`; mutants 28 to 32 in `demo/mutants.ts`.
- The house's revenue is the 5% rake on duels between people who know each other (friends, clubs,
  tournaments with known entrants); the public ladder is free.
