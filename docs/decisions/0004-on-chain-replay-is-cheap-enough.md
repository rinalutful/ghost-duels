# 0004: Measured: on-chain replay costs about 1.3 Tgas, so this game doesn't need a TEE

## Context

The pitch is "a TEE replays your inputs". Before building around that, the rules say to measure
whether it's needed. The sim is small and integer-only, so the contract can link it.

## Decision

Keep the TEE path the design asked for (0003), and also ship `ReplayMode::OnChain`, measured:

| Run | Ticks | Button changes | Replay gas (in-contract) | Whole `submit_run` tx |
|---|---|---|---|---|
| 1 | 425 | 323 | 0.21 Tgas | 3.1 Tgas |
| 2 | 1523 | 731 | 0.61 Tgas | 4.0 Tgas |
| 3 | 2621 | 1571 | 1.03 Tgas | 5.5 Tgas |
| 4 | 3149 | 1731 | 1.23 Tgas | 5.9 Tgas |

(sandbox, nearcore 2.14, 2026-10-30; `docs/evidence/sandbox.txt`.) A full 60 s run is under 2 Tgas
of replay and about 6 Tgas in all, against a 300 Tgas limit. Most of the transaction is parsing the
JSON log, not simulating.

## Consequences

- For *this* game, on-chain replay is strictly better: trustless, settled in the same transaction,
  no fee, no runner, no OutLayer. The honest framing for judges: the contract replays small games
  itself; OutLayer is the path for a game whose sim doesn't fit in 300 Tgas (a physics game, minutes
  long), or whose inputs must stay private (a TEE can verify a run without publishing the log).
- The testnet deploy stays in Runner mode because that is the path the design asked to demonstrate;
  `set_mode OnChain` switches it (one owner call). Open question for the owner: which mode the entry
  leads with.
