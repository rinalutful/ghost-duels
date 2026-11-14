// `npm run deploy-v3`: the one-time setup of Ghost Duels v3 on testnet (docs/decisions/0014). v1
// (duels.ghost-duels-jbx5v9.testnet) and v2 (v2.ghost-duels-jbx5v9.testnet) are left as they are.
//   1. The funding account (FUNDER_ID, default gd-v2-59lavk.testnet: the second faucet account of
//      2026-11-06, issue #14; no new faucet draw) creates v3.<funder> with enough for its code.
//   2. One transaction, signed by v3's own key: deploy res/ghost_duels.wasm (checked against
//      res/SHA256SUMS), new(owner: ghost-duels-jbx5v9.testnet, mode: OnChain, offchain_allowed: false),
//      and delete that key. Afterwards the account has no access keys: nobody can redeploy it or move
//      its NEAR, and its owner can only call the bounded owner methods. `npm run verify` checks 0 keys.
// The funder's key comes from the keychain (service near-lab-testnet).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actions, KeyPair, type KeyPairString } from "near-api-js";
import { balance, exists, keyed, near, provider, sendActions, txLink, view } from "./src/near.ts";
import { keychainLoad } from "./src/keys.ts";
import { REPO_FUNDER, V3_CONTRACT as SHARED_CONTRACT } from "./src/world.ts";

// History since v4 (0020): re-running it only prints v3's state.
const SHARED_FUNDER = "gd-v2-59lavk.testnet";

const res = (f: string) => readFileSync(new URL(`../res/${f}`, import.meta.url));
const wasm = res("ghost_duels.wasm");
const sums = Object.fromEntries(res("SHA256SUMS").toString().trim().split("\n").map((l: string) => l.split(/\s+/).reverse()));
if (createHash("sha256").update(wasm).digest("hex") !== sums["ghost_duels.wasm"]) throw new Error("res/ghost_duels.wasm doesn't match res/SHA256SUMS");

const funder = keyed(SHARED_FUNDER);
console.log(`funder: ${funder.id} (${near(await balance(funder.id))})`);
if (!(await exists(SHARED_CONTRACT))) {
  const amount = (Number(BigInt(wasm.length) * 10n ** 19n / 10n ** 21n) / 1000 + 0.4).toFixed(3);
  const key = KeyPair.fromRandom("ed25519");
  const { keychainSet } = await import("./src/keys.ts");
  keychainSet(SHARED_CONTRACT, key.toString());
  const tx = await sendActions(funder, SHARED_CONTRACT, [actions.createAccount(), actions.transfer(BigInt(Math.round(Number(amount) * 1000)) * 10n ** 21n), actions.addFullAccessKey(key.getPublicKey())]);
  console.log(`${funder.id} created ${SHARED_CONTRACT} with ${amount} NEAR: ${txLink(tx)}`);
}
if (!(await view(SHARED_CONTRACT, "get_config").then(() => true, () => false))) {
  const v3 = keyed(SHARED_CONTRACT);
  const pk = KeyPair.fromString(keychainLoad(SHARED_CONTRACT) as KeyPairString).getPublicKey();
  const tx = await sendActions(v3, SHARED_CONTRACT, [
    actions.deployContract(wasm),
    actions.functionCall("new", { owner: REPO_FUNDER, mode: "OnChain", offchain_allowed: false }, 30n * 10n ** 12n, 0n),
    actions.deleteKey(pk),
  ]);
  console.log(`deployed ${SHARED_CONTRACT} (OnChain only, owner ${REPO_FUNDER}) and deleted its only key: ${txLink(tx)}`);
}
const keys = await provider.viewAccessKeyList({ accountId: SHARED_CONTRACT });
console.log(`\n${SHARED_CONTRACT}: ${near(await balance(SHARED_CONTRACT))}, ${keys.keys.length} access keys; config ${JSON.stringify(await view(SHARED_CONTRACT, "get_config"))}`);
