# 0005: Ghosts are a hand-rolled NEP-171 with live metadata

## Context

A top run becomes an asset: a ghost that earns when challengers lose, tradeable, showing its record.
`near-contract-standards`' NFT is the usual route, but contracts in our sibling repos on this SDK
already run 150 to 300 KB (near-account-nfts' collection is 307 KB), and storage costs about 1 NEAR
per 100 KB. A record stored in token metadata
would also go stale or need rewriting on every duel.

## Decision

`contracts/ghost-duels/src/nft.rs` implements NEP-171 core (`nft_transfer`, `nft_transfer_call`
with `nft_resolve_transfer`, `nft_token`), NEP-177 metadata, NEP-181 enumeration and NEP-297
events. A token's metadata is computed when read from the `Ghost` record: the title has the score;
the description and `extra` have held/beaten/earned/pot/stake; `media` is an SVG data URI drawn
from the same numbers. No approvals (NEP-178): `approval_id` must be omitted. Transfers need 1
yoctoNEAR, so a session key can't trade.

## Consequences

- The record a wallet shows is always current, and nothing is rewritten per duel.
- No marketplace approvals: a sale is a transfer by the owner. Adding NEP-178 is an issue.
- The contract is still 304 KB (the SDK's baseline is large: near-verdict's small escrow is 149 KB),
  about 3 NEAR of storage.
- Enumeration by owner scans all ghosts; fine at hackathon scale, an index later.
