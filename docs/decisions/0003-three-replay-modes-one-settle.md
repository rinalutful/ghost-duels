# 0003: Three replay modes feed one settle; tonight's runner is trusted, not a TEE

## Context

The design asks for settlement by a TEE replay through OutLayer's `request_execution` with
yield/resume. A hosted run on `outlayer.testnet` needs the job at a public https URL (the repo is
private until the owner publishes it), and we may not sign up for services. So tonight the replay
has to run somewhere else, without pretending to be a TEE.

## Decision

`Config.mode` picks who replays; every mode ends in the same private `settle(run, replay)`:

- `Runner`: the run waits in `pending_replays`; an allowlisted runner account replays it with the
  wasip2 job under wasmtime (`demo/src/world.ts` `runnerPass`, `npm run runner`) and calls
  `submit_replay`. The contract checks the runner, and that the job's `log_hash` equals the hash it
  stored at submit, so a runner can't settle a run with another log. Every replay's `via` says
  "a trusted runner, not a TEE". This is the testnet deploy's mode.
- `OutLayer`: `submit_run` calls `request_execution` with the current 7-argument signature
  (`source: {WasmUrl: {url, hash, build_target: "wasm32-wasip2"}}`, limits, `input_data =
  {seed, log}`, `response_format: "Json"`), attaching the replay fee, `.then(on_replay)`. The
  callback is typed as OutLayer's own `on_execution_response` returns: the guest's JSON, or `null`
  on failure or timeout (out-layer/outlayer `execution.rs`, `output_return_bytes`, read 2026-10-30).
  Not the `{success, result, error}` envelope in their private-dao example, which is that guest's
  own stdout. Null, an unparsable answer or a log-hash mismatch voids the run and refunds the stake.
  The sandbox runs this path against `contracts/mock-outlayer` (real `promise_yield_create` /
  `promise_yield_resume`); the suite plays the worker with the real job under wasmtime, and lets a
  yield time out.
- `OnChain`: the contract replays the log in `submit_run` itself (see 0004).

## Consequences

- One settlement path: the cheat checks (claimed vs replayed score) and the payouts are the same
  whoever replayed.
- The runner is a trust assumption: it could lie about a score. It can't replay a different log, and
  its account is named in every replay. Moving to OutLayer replaces it with OutLayer's registered TDX
  workers (DCAP-checked at registration, per OutLayer's docs; per-run attestation is off-chain).
- Owner step: once the repo is public, `set_outlayer` with the raw GitHub URL of
  `res/ghost_replay_job.wasm` at a commit and its sha256, then `set_mode OutLayer` (README).
