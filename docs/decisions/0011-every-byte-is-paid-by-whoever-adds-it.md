# 0011: Every byte is paid by whoever adds it; settlement draws on a refundable reserve

## Context

v1 charged storage only in `start_run` and `mint_ghost`. The AI judge measured what slipped through:
a settled run added 263 B unpaid, a pending 2048-toggle log 8,455 B, a first deposit nothing. On the
live contract the free balance over what it owed was at most 0.32 NEAR, so a few maximum-length
pending logs could eat into players' money.

## Decision

- Each path that grows state measures it (`env::storage_usage()` after flushing the collections)
  and charges the account that caused it at the chain's price: `deposit` (from the deposit),
  `set_key_cap`, `start_run`, `submit_run` (the pending log), `nft_transfer` (a longer owner id).
- Settlement can happen in a call the player doesn't sign (the runner's, OutLayer's callback,
  anyone's `expire_run`), where a balance might be empty and a panic would leave the run stuck. So
  `start_run` takes a **reserve** of 2,000 bytes' worth (0.02 NEAR), and an on-chain qualifier also
  reserves its log's bytes at submit. `finish` pays what settlement added from the reserve and
  refunds the rest; storage the run frees (its pending log) goes back to the player.
- `paid_storage` counts what players have paid, net of refunds; `get_storage` shows it.
- Two property tests run 200 random actions each (OnChain and Runner) and check after every step:
  balances + pots + what live runs hold + paid storage = deposits − withdrawals, and paid storage ≥
  every byte stored since setup.

## Consequences

- A run costs about 0.006 NEAR of storage in all; the reserve is refunded at settlement.
- The owner's own configuration (runners, OutLayer URL) is paid by the contract's account.
