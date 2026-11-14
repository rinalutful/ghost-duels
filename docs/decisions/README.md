# Decision records

Short records of *why* a non-obvious choice was made, not *what* the code does (the code and its
docstrings are the source of truth for that).

Each record has **Context** (the problem or constraint), **Decision** (what was decided) and
**Consequences** (what it costs or rules out, with pointers to the files).

Conventions: numbered sequentially, never renumbered; never deleted or rewritten. A later decision
that supersedes one gets a new record, noted in both (strike the old one through in the index,
pointing at the new number). One decision per file.

| # | Decision |
|---|---|
| [0001](0001-one-integer-sim-three-builds.md) | The game is one integer-only Rust crate, built for the browser, the replay job and the contract; a kill test holds them identical |
| [0002](0002-the-seed-comes-from-the-block-at-start.md) | Each run's cave comes from the block's randomness at `start_run`, so ghosts and challengers fly different caves and compare by score |
| [0003](0003-three-replay-modes-one-settle.md) | Three replay modes (on-chain, registered runner, OutLayer) feed one settle; tonight's runner is trusted, not a TEE (its void rule: ~~superseded by 0012~~) |
| [0004](0004-on-chain-replay-is-cheap-enough.md) | Measured: the contract can replay a full run for about 1.3 Tgas, so this game doesn't need a TEE to be trustless |
| [0005](0005-hand-rolled-nep-171-with-live-metadata.md) | Ghosts are a hand-rolled NEP-171 whose metadata is computed from the live record; no approvals |
| [0006](0006-the-economy.md) | ~~The economy: the owner funds a pot, a loss pays the owner the stake minus rake, a win takes the pot, one challenger at a time~~ (minting and payouts superseded by 0009, voids by 0012, one challenger at a time by 0015) |
| [0007](0007-sessions-spend-an-in-game-balance.md) | Sessions are function-call keys spending an in-game balance; withdraw needs a full-access key; social login is the next step (the stolen-key risk: ~~superseded by 0010~~) |
| [0008](0008-a-bot-needs-only-the-screen.md) | Measured: a bot that sees only the screen flies as well as one that knows the whole cave, so no segmented reveal; a bot still beats people both ways |
| [0009](0009-ghosts-are-committed-before-the-cave.md) | Ghosts are committed before their cave exists (pot locked, auto-minted, 20% to abandon, a day's pot lock); kept stakes split 5/25/70 and grow the pot (refills and retire: amended by 0016) |
| [0010](0010-session-keys-have-a-spending-cap.md) | Session keys spend only up to a cap their account set with a full-access key; no cap, no spending (storage: amended by 0017) |
| [0011](0011-every-byte-is-paid-by-whoever-adds-it.md) | Every path that grows state charges whoever caused it; settlement draws on a refundable per-run reserve |
| [0012](0012-no-run-is-voided.md) | No run is voided: a failed or missing replay is done on-chain; a failed OutLayer call refunds its fee |
| [0013](0013-v2-on-a-new-account-in-on-chain-mode.md) | v2 goes to a new account in on-chain mode; v1 stays as history (its owner powers: ~~superseded by 0014~~) |
| [0014](0014-v3-is-locked-and-on-chain-only.md) | v3 has no access keys and replays on-chain only; the owner keeps only bounded `set_params` |
| [0015](0015-any-number-may-race-a-ghost.md) | No locks: any number race a ghost at once; the first to beat it takes the pot, later winners get their stake back (~~so an owner can't pull the pot from under a winner~~: corrected by 0022; for staked ghosts amended by 0023) |
| [0016](0016-a-ghost-pot-is-what-it-qualified-with.md) | A refill only restores the qualified pot; kept stakes' pot share goes to the house on retire (~~its price claim for a faked defence~~: superseded by 0018) |
| [0017](0017-a-key-cap-covers-storage.md) | ~~A session key's cap covers the run's reserve and storage too~~ (superseded by 0020) |
| [0018](0018-round-three-terms-floors-and-no-price-claim.md) | Qualifiers can refuse the owner's terms; no race below the stake; the token claims no price for a fake record (deployed in v4, 0020; ~~a key's cap counts losses only~~: superseded by 0020) |
| [0019](0019-staked-play-is-a-private-duel.md) | Staked play is a private duel: a staked ghost names its challengers (full-access key), only they race it; ghosts with no pot are a public ladder where no money moves |
| [0020](0020-v4-locked-on-a-new-account-key-caps-count-all-storage.md) | v4 on a new locked account (`v4.near-ghost-duels-rywu8u.testnet`); a key's cap counts every byte its runs store, the reserve held while in flight |
| [0021](0021-the-page-is-the-game-ink-on-paper.md) | The page is the game: the title flies a real ghost's recorded run, the board draws each ghost's flight from its log, ink on paper with you in orange and the ghost in blue; chain details one click away |
| [0022](0022-a-duels-owner-can-take-the-pot-first.md) | A duel's owner can name a second account mid-race and take the pot before a winner lands: stated as a limit of v4 (which can't change), fixed only in a new version |
| [0023](0023-a-duel-takes-one-race-at-a-time.md) | v5: a duel takes one race at a time and its list can't change mid-race, which closes 0022; a stale race is closed by the next call; a failed withdrawal comes back; a qualifier holds its recording's storage from the start |
| [0024](0024-a-staked-start-names-the-pot-it-was-shown.md) | v5: `start_run` takes `min_pot` and refuses a pot smaller than the challenger was shown; `retire_ghost` closes a stale race before it reads the pot lock |
| [0025](0025-the-page-does-one-thing-at-a-time.md) | The page does one thing at a time: nothing new starts while a real race or a transaction is pending, an answer for an old screen is dropped, background reads never take the screen |
