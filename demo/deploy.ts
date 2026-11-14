// The owner's tool: replace the shared deploy's code with res/ghost_duels.wasm in place (no `new`, so
// the state stays). Only for a build whose state layout matches the live one. First-time setup is
// done by `npm run demo -- --shared` (src/world.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actions, baseEncode } from "near-api-js";
import { keyed, provider, sendActions, txLink } from "./src/near.ts";
import { SHARED_CONTRACT } from "./src/world.ts";

const contract = process.env.GD ?? SHARED_CONTRACT;
const wasm = readFileSync(new URL("../res/ghost_duels.wasm", import.meta.url));
const local = baseEncode(createHash("sha256").update(wasm).digest());
const live = (await provider.viewAccount({ accountId: contract })).code_hash;
if (live === local) {
  console.log(`${contract} already runs res/ghost_duels.wasm (${local})`);
} else {
  const tx = await sendActions(keyed(contract), contract, [actions.deployContract(wasm)]);
  console.log(`${contract} upgraded ${live} -> ${local}: ${txLink(tx)}`);
}
