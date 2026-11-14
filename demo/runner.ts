// `npm run runner`: the registered runner for the owner's shared deploy (or GD=<contract>), as a
// loop: every few seconds, replay each pending run with the wasip2 job under wasmtime and submit
// the result. Needs runner.<funder>'s key in the keychain. A trusted runner, not a TEE (README).
import { keyed } from "./src/near.ts";
import { runnerPass, SHARED_CONTRACT, SHARED_FUNDER } from "./src/world.ts";
import { wasmtimeVersion } from "./src/replay.ts";

// v4 runs in OnChain mode and needs no runner; this is for a deploy made to allow Runner mode.
const funder = SHARED_FUNDER;
const contract = process.env.GD ?? SHARED_CONTRACT;
const runner = keyed(process.env.RUNNER ?? `runner.${funder}`);
console.log(`runner ${runner.id} for ${contract}, ${wasmtimeVersion()}; Ctrl-C to stop`);
for (;;) {
  try {
    await runnerPass({ contract, runner });
  } catch (e) {
    console.error(String(e).slice(0, 200));
  }
  if (process.argv.includes("--once")) break;
  await new Promise((ok) => setTimeout(ok, 3000));
}
