# 0001: One integer-only sim crate, three builds, held identical by a kill test

## Context

The whole claim is that a faked score can't win: the contract trusts a *replay* of the player's
inputs, not the score the client reports. That only works if the replay computes exactly what the
player saw. Browsers, wasmtime and NEAR's VM are three different runtimes; floating point, iteration
order, or a dependency's platform-specific code could make them disagree, and one disagreement makes
an honest player look like a cheater.

## Decision

- The game is one crate, `game/sim` (`ghost-sim`): `no_std`, no allocator, no dependencies, no
  floats. Positions are Q8 fixed point; randomness is an xorshift64* seeded by splitmix64 from the
  run's 32-byte seed; the only input is the list of ticks at which the button changed.
- It compiles three ways, each a thin front-end:
  - `game/sim-web` (wasm32-unknown-unknown, plain C-ABI exports, no wasm-bindgen) for the browser,
    and for Node, so the kill test runs the exact file the page loads;
  - `game/replay-job` (wasm32-wasip2, stdin JSON to stdout JSON) for a TEE worker or a runner;
  - the contract itself (`contracts/ghost-duels`, Rust 1.93), for on-chain replay.
- `final_state_hash` is sha256 over a fixed little-endian serialization of the whole state
  (`Game::state_bytes`); `log_hash` is sha256 over the log's ticks as u32 little-endian. Both are
  computed by each side's own sha256 (WebCrypto/Node, the `sha2` crate, `env::sha256`).
- The live browser game records the toggles *inside the wasm* as it steps, so the log the page
  submits is exactly what `replay` consumes.

## Consequences

- Kill test (`npm run killtest`, `docs/evidence/killtest.txt`): 44 logs (40 from live autopilot play
  in the browser build, 4 edge cases) and 3 refusals; 47/47 identical between the browser build in
  Node and the wasip2 job under wasmtime 50.0.1. The sandbox suite adds the third build: 5 runs where
  the contract's replay, the job and a native build give the same score and state hash.
- The game is necessarily simple (a one-button cave flyer). Anything richer must stay integer-only
  and deterministic; there's no physics engine to lean on.
- The log is capped at 2048 button changes per run; past that the button stops changing (the page
  and the replay agree on that rule). A human taps far fewer; the autopilot gets close.
