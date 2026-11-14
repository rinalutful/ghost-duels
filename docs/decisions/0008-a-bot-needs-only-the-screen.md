# 0008: A bot needs only what is on screen, so the cave isn't revealed in segments; minting is committed instead

## Context

The AI judge (2026-11-06) found that a bot wins the economy. `start_run` handed out the whole seed,
a player had 600 s to submit a 60 s run, and its 100-line beam search flew a median 2411 on 300
caves (the best testnet ghost: 738). Best-of-30 minting then made a bot's ghost one that the same
bot beats on only 2.4% of caves. It suggested revealing the cave in segments seeded by later blocks,
so the future can't be searched, and the brief asked for a near-real-time deadline and a minting rule
that kills best-of-N, then for the bot to be re-run against the new design.

Before changing the sim (a new game version, three rebuilt wasm files, a transaction per segment
inside a 60 s game), we measured what a segment reveal could take away from the bot.
`bot/` holds the judge's beam search (it reproduces the judge's first caves exactly: 2461, 2361,
2411, 1690, 2261) with two more modes:

- **receding horizon**: plan N ticks ahead, commit 0.5 s, plan again. Up to ~70 ticks of plan,
  everything the plan touches is already drawn on screen (the ship sits 248 px from the right
  edge, the cave scrolls 2-3.5 px a tick). So this is a bot that knows exactly what a human sees;
- **a human model**: every 4-6 ticks it looks at the cave 60 px ahead with a slowly drifting aim
  error, and acts 8-11 ticks (130-180 ms) later. No search. It is a model, not people; it drives the
  page test and the demo video too.

| Who flies (same 40 caves as the judge's first 40) | Median | p10 | p90 | Survived 60 s |
|---|---|---|---|---|
| Beam search, the whole cave known (the judge's bot) | 2386 | 1379 | 2586 | 33/40 |
| Beam search, plans 1.0 s ahead (on-screen only) | 2461 | 2050 | 2686 | 35/40 |
| Beam search, plans 0.5 s ahead | 725 | 406 | 1635 | 1/40 |
| Human model, 300 caves | 281 | 200 | 434 | 0/300 |

(`docs/evidence/bot/*.txt`; `npm run bot` re-runs them.) A bot that sees only the screen and plans one
second ahead flies as well as one that knows the whole cave (better, since it re-plans). No reveal
scheme can hide less than the screen, so segments seeded by later blocks would cost a transaction
per segment and a new game version, and take nothing from this bot.

## Decision

- **No segmented reveal.** The sim and every existing replay stay as they are.
- **The deadline is near real time**: `run_secs` 90 s for a 60 s game (bounded 65..600 for the
  owner). It doesn't stop a bot (its search takes about a second), but it ends long holds on a
  ghost (0012) and offline searching of a fresh cave for minutes.
- **Minting is committed before the cave exists** (0009): a qualifier locks its pot at
  `start_run`, any qualifying score becomes a ghost automatically, a try that falls short or is
  abandoned costs 20% of the pot, and a ghost's pot can't be retired for a day. A bot that wants a
  stronger ghost than one draw pays for every cave it throws away.

Re-run against v2 (`bot300` for the bot's scores, 300 human-model caves; P = the challenger's score
is strictly higher, ties go to the ghost):

| Duel | Win chance |
|---|---|
| bot vs a bot ghost from one committed run (v2) | 45-48% |
| bot vs a bot ghost from the best of 30 (v1) | 2.4% |
| bot vs a best-of-k ghost under v2 (k = 2 / 3 / 5 / 10 / 30) | 30 / 22 / 15 / 7 / 2.4%, costing 0.2 / 0.4 / 0.8 / 1.8 / 5.8 pots in abandon fees |
| human model vs a human-model ghost (one run) | 50% |
| **bot vs a human-model ghost** | **99.8%** |
| **human model vs a bot ghost** | **0.15%** |

## Consequences

- **Where a bot still wins: against people, both ways.** A bot challenger takes almost every human
  ghost's pot, and a bot's ghost is almost never beaten by a human. Replay verification proves a
  score was flown from the submitted inputs; it can't prove who or what produced them. The README
  says so in its first lines, not in a footnote.
- What v2 does limit: cherry-picked ghosts (their price is now explicit), stakes a stolen key can
  lose (0010), and how long a ghost can be held (90 s).
- What would close the gap is a humans-only ladder: proof of personhood or a device attestation
  on `start_run`. Neither exists on NEAR testnet in a form we could use tonight; filed as an issue.
- Our own testnet demo and video use the human model and say so; the bot is kept as `npm run bot`.
