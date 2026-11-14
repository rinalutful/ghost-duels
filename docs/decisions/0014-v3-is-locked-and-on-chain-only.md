# 0014: v3 has no access keys and replays on-chain only

Supersedes the "owner powers" consequences of [0013](0013-v2-on-a-new-account-in-on-chain-mode.md).

## Context

The AI judge's second round (2026-11-06): v2's account still held a full-access key, so whoever held
it could redeploy the code or move the contract's NEAR (every balance and pot), and the README
understated that. The owner account could also switch v2 to Runner mode with a runner of its own,
which would then report whatever scores it liked.

## Decision

- v3 (`v3.gd-v2-59lavk.testnet`) is deployed by `npm run deploy-v3` in one transaction signed by its
  own key: deploy, `new(owner, OnChain, offchain_allowed: false)`, delete that key. The account has
  no access keys left: no one can redeploy it, delete it or move its NEAR except through its methods.
  `npm run verify` checks `0 keys`.
- `offchain_allowed: false` makes `set_mode`, `set_runners` and `set_outlayer` refuse, so the only
  referee is the contract's own replay.
- What the owner account (`ghost-duels-jbx5v9.testnet`) can still do is `set_params`, bounded, and
  a run keeps the terms it started with (rake, pot share, abandon fee, minimum score, pot lock).
  The README lists it exactly.
- v3's funder is `gd-v2-59lavk.testnet`, the second faucet account drawn by mistake earlier that
  night (issue #14); the repo's funder isn't touched.

## Consequences

- A bug in v3 can't be fixed in place: a fix is a v4 on a new account, like this one.
- The OutLayer path (`npm run outlayer`) needs a deploy made with `offchain_allowed: true`; v3 is not
  one, on purpose. The path stays built and sandbox-tested.
