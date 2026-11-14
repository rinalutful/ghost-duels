# Earlier deploys (history)

The live contract is v4 (README). These came before it and are untouched; `npm run verify` checks
that each still runs the code recorded here.

| Version | Account | What it was |
|---|---|---|
| v3 | [`v3.gd-v2-59lavk.testnet`](https://testnet.nearblocks.io/address/v3.gd-v2-59lavk.testnet) | Locked (no access keys), on-chain replay only (0014). Staked races were open to anyone; 0019 made them private duels in v4. Its build is `res/v3/`; outputs in `docs/evidence/testnet-*-v3.txt`. |
| v2 | [`v2.ghost-duels-jbx5v9.testnet`](https://testnet.nearblocks.io/address/v2.ghost-duels-jbx5v9.testnet) | The first review's findings fixed, on a new account in on-chain mode (0013). Still holds a key. |
| v1 | [`duels.ghost-duels-jbx5v9.testnet`](https://testnet.nearblocks.io/address/duels.ghost-duels-jbx5v9.testnet) | The first version (2026-10-30). |

The committed video `docs/demo/ghost-duels-demo.mp4` and the images beside it were recorded on v3
with the page's earlier look, and show a staked race open to a stranger, which v4 no longer allows.
They are kept as a record of v3, not as a picture of the current game.

The judge command's first measured runs: `docs/evidence/judge-fresh-clone.txt` (macOS),
`docs/evidence/judge-linux-2cpu.txt` (Debian 12, 2 CPUs), `docs/evidence/judge-full-mac.txt`.
