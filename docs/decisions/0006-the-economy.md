# 0006: The economy

## Context

"If the challenger beats the ghost's score, they take the pot; otherwise the ghost's owner earns the
stake, minus a small house rake." That needs a source for the pot and rules for concurrency,
cheating, timeouts and failures.

## Decision

- **Minting** a ghost (from a verified practice run, or a challenge you won, scoring at least
  `min_ghost_score`) moves a **pot** from the minter's in-game balance into the ghost, and sets its
  **stake** (at least `min_stake`, at most the pot). The minter re-sends the log, which must hash to
  what was submitted; it is stored so anyone can watch and check the ghost. Storage is charged to the
  minter's balance at the chain's rate.
- **Loss** (score ≤ the ghost's): the house takes `rake_bps` (5%) of the stake, the ghost's current
  owner the rest. **Win**: the challenger gets the pot and their stake back; the pot goes to zero
  (the ghost is "beaten" until its owner refills it), and the winning run can be minted as the new
  champion. Whoever owns the NFT at settlement is paid, so a bought ghost earns for its buyer.
- **One challenger at a time** per ghost (`locked_by`), so a pot can't be paid twice. A lock held by
  a run past its deadline is released by the next `start_run` or `retire_ghost`, which expires it.
- **Refused** (claimed score ≠ replayed score) and **Expired** (not submitted in time) settle like a
  loss: the stake goes to the ghost's owner. **Voided** (the replay never came, or the job failed)
  refunds the stake, and the fee unless it was already paid to OutLayer.
- A **replay fee** per run (0.01 NEAR on testnet) pays the runner, or is attached to OutLayer.

## Consequences

- A ghost owner's expected return depends on how often challengers beat the score; the stake/pot
  ratio is theirs to set. No dynamic pricing yet.
- Locking makes a popular ghost a queue; many ghosts per champion score is the workaround.
- The rake accrues to the owner account's in-game balance.
