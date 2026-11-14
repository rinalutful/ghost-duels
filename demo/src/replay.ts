// Runs the replay job (res/ghost_replay_job.wasm, wasm32-wasip2) the way an OutLayer worker would:
// the run's input on stdin, the result JSON on stdout. Locally that's wasmtime. Without wasmtime
// installed, `runJob` says so and stops: nothing here pretends to have run the job.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const JOB_WASM = fileURLToPath(new URL("../../res/ghost_replay_job.wasm", import.meta.url));

export type JobOut = { score: number; metres: number; gems: number; ticks: number; survived: boolean; final_state_hash: string; log_hash: string; error?: string };

export function wasmtimeVersion(): string {
  try {
    return execFileSync("wasmtime", ["--version"]).toString().trim();
  } catch {
    throw new Error("wasmtime is not installed: `brew install wasmtime` or `curl https://wasmtime.dev/install.sh -sSf | bash`");
  }
}

export function runJob(input: { seed: string; log: number[] }): JobOut {
  const out = execFileSync("wasmtime", ["run", JOB_WASM], { input: JSON.stringify(input), maxBuffer: 1 << 20 }).toString();
  return JSON.parse(out) as JobOut;
}
