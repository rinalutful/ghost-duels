# 0020: v4 goes to a new locked account; a key's cap counts every byte its runs store

Supersedes [0017](0017-a-key-cap-covers-storage.md) and the cap part of [0018](0018-round-three-terms-floors-and-no-price-claim.md).
Resolves a bug our own AI review found (2026-11-10) and issue #18.

## Context

- JUDGES.md row 7 claimed "a stolen session key loses at most its cap, storage included". Our review
  found two paths where it didn't hold: a qualifier's ghost-log storage, debited in
  `submit_run`, and settlement storage above the run's reserve, debited in `finish`, both came out
  of the player's balance without counting against the key that started the run. 0018 had also
  stopped counting the reserve, so a thief with many runs in flight could overrun the cap by their
  settlements.
- v3 has no keys (0014), so neither these fixes nor 0018's nor 0019's could reach it. Its funder had
  2.1 NEAR left, short of the ~3.5 a locked deploy needs.

## Decision

- **Every run remembers the capped key that started it** (`Run.key`; none when the account itself
  starts it with 1 yoctoNEAR). Whatever the run takes later counts against that key, whoever signs:
  the ghost log's storage at submit (refused there if it doesn't fit), a pending log's storage, and
  settlement's storage.
- **The reserve is held on the key while the run is in flight**, then released at settlement minus
  what settlement used. So a key's `spent` is what its runs lost plus what they hold, and never more
  than its cap; once its runs settle, it equals what the balance lost (exactly, in on-chain mode; in
  off-chain modes it keeps counting a pending log that came back, erring on the safe side).
- The reserve is sized so settlement never needs more: 2000 bytes for a qualifier, 1000 for a
  challenge or practice run. `settlement_storage_fits_in_the_reserve` measures the worst cases with
  64-character accounts and new balance entries (760 and 343 bytes).
- **v4 goes to a new account and is locked like v3**: `v4.near-ghost-duels-rywu8u.testnet`, created
  by a new funder (`near-ghost-duels-rywu8u.testnet`, one faucet draw, its key in the builder's OS
  keyring), deployed, initialised (`OnChain`,
  `offchain_allowed: false`, owner = that funder) and its only key deleted in one transaction
  (`npm run deploy-v4`). It carries 0018, 0019 and this record. v3, v2 and v1 stay as history;
  `npm run verify` checks v4's code hash against `res/ghost_duels.wasm` and `res/v4/SHA256SUMS`, its
  0 keys, and that v3 is untouched.

## Consequences

- Tests: `attack_key_cap_counts_ghost_log_and_settlement_storage` (the key counts exactly what the
  balance lost), `settlement_storage_fits_in_the_reserve`, and
  `property_a_session_key_never_loses_more_than_its_cap` (300 random steps of a thief running a
  stolen key with many runs in flight, settled by anyone). Mutants 33 to 35, and 21 and 25 retargeted.
- `attack_key_cap_counts_losses_not_the_refunded_reserve` (0018) still holds: after settlement the
  reserve no longer counts. While a run is in flight, it does.
- The build isn't reproducible yet (`cargo near build non-reproducible-wasm` plus wasm-opt); the
  claim is that the deployed code hash equals the committed `res/ghost_duels.wasm`, which is this
  source's build on macOS (Rust 1.93, cargo-near 0.22, wasm-opt from Homebrew).

Edited 2026-11-10: internal process wording removed (which review round, which machine); nothing else changed.
