# 0002: The cave comes from the block at `start_run`; ghosts are compared by score

## Context

Two designs were possible. (a) Trackmania-style: the challenger flies the ghost's own cave (same
seed), so the ghost's recording overlays perfectly. (b) Each run gets a fresh cave. In (a) the cave
is public before anyone stakes, so a challenger can practise it, or search it with a bot, offline
for as long as they like, and stake only once they hold a winning log. The replay would confirm that
log honestly: replay verification stops faked scores, not prepared ones.

## Decision

(b). `start_run` locks the stake first and only then draws the seed:
`sha256(env::random_seed() ‖ run id ‖ player)`. The client never chooses it. The run must be
submitted within `run_secs` (600 s by default), or anyone can expire it, which forfeits the stake.
Ghost and challenger fly different caves and are compared by score (strictly greater wins; a tie
goes to the ghost). The cave's difficulty is a function of distance only (the gap narrows, the walls
steepen, spikes appear at fixed rates), so caves differ in layout, not in how hard they get.

## Consequences

- No offline preparation of a specific cave, and abandoning a bad-looking cave costs the stake.
- Luck: some caves are kinder than others. Accepted for a hackathon; a fairer version could score
  each run against the median of many autopilot runs on the same seed.
- The page's ghost flies its own recorded line through *your* cave, translucent (a ghost passes
  through rock); the dashed line where it crashed is the distance to beat.
- Not stopped: a bot that plays the fresh cave inside the submission window. Replay verification
  can't tell a superhuman input log from a human one. Mitigations (a minimum real-time duration, human
  input statistics) are issue material, not built.
- `env::random_seed()` is the block's VRF output; a block producer could in principle bias it. Fine
  for testnet stakes.
