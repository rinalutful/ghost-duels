// `npm run deploy-v4`: the one-time setup of Ghost Duels v4 on testnet (docs/decisions/0020), the
// same way v3 was made (0014). v3, v2 and v1 are left as they are.
//   1. The funder (V4_FUNDER, one faucet draw) creates v4.<funder> with enough
//      for its code, and a temporary full-access key for v4 that goes to the keyring first.
//   2. One transaction, signed by that key: deploy res/ghost_duels.wasm (checked against
//      res/SHA256SUMS), new(owner: the funder, mode: OnChain, offchain_allowed: false), and delete the
//      key. The account then has no access keys: nobody can redeploy it or move its NEAR, and its
//      owner can only call the bounded owner methods. `npm run verify` checks 0 keys and the code hash.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actions, KeyPair, type KeyPairString } from "near-api-js";
import { balance, exists, keyed, near, provider, sendActions, txLink, view } from "./src/near.ts";
import { keychainLoad, keychainSet } from "./src/keys.ts";
import { SHARED_CONTRACT, V4_FUNDER } from "./src/world.ts";

if (!V4_FUNDER) throw new Error("no V4_FUNDER in demo/src/world.ts: npm run funder first");
const res = (f: string) => readFileSync(new URL(`../res/${f}`, import.meta.url));
const wasm = res("ghost_duels.wasm");
const sums = Object.fromEntries(res("SHA256SUMS").toString().trim().split("\n").map((l: string) => l.split(/\s+/).reverse()));
if (createHash("sha256").update(wasm).digest("hex") !== sums["ghost_duels.wasm"]) throw new Error("res/ghost_duels.wasm doesn't match res/SHA256SUMS");

const funder = keyed(V4_FUNDER);
console.log(`funder: ${funder.id} (${near(await balance(funder.id))})`);
if (!(await exists(SHARED_CONTRACT))) {
  // The code's storage (1 NEAR per 100 KB) plus 0.4 for the state and the first transactions.
  const milli = (BigInt(wasm.length) * 10n ** 19n) / 10n ** 21n + 400n;
  const key = KeyPair.fromRandom("ed25519");
  keychainSet(SHARED_CONTRACT, key.toString()); // read back before the account exists
  const tx = await sendActions(funder, SHARED_CONTRACT, [actions.createAccount(), actions.transfer(milli * 10n ** 21n), actions.addFullAccessKey(key.getPublicKey())]);
  console.log(`${funder.id} created ${SHARED_CONTRACT} with ${near(milli * 10n ** 21n)}: ${txLink(tx)}`);
}
if (!(await view(SHARED_CONTRACT, "get_config").then(() => true, () => false))) {
  const v4 = keyed(SHARED_CONTRACT);
  const pk = KeyPair.fromString(keychainLoad(SHARED_CONTRACT) as KeyPairString).getPublicKey();
  const tx = await sendActions(v4, SHARED_CONTRACT, [
    actions.deployContract(wasm),
    actions.functionCall("new", { owner: V4_FUNDER, mode: "OnChain", offchain_allowed: false }, 30n * 10n ** 12n, 0n),
    actions.deleteKey(pk),
  ]);
  console.log(`deployed ${SHARED_CONTRACT} (OnChain only, owner ${V4_FUNDER}) and deleted its only key: ${txLink(tx)}`);
}
const keys = await provider.viewAccessKeyList({ accountId: SHARED_CONTRACT });
console.log(`\n${SHARED_CONTRACT}: ${near(await balance(SHARED_CONTRACT))}, ${keys.keys.length} access keys; code ${(await provider.viewAccount({ accountId: SHARED_CONTRACT })).code_hash}; config ${JSON.stringify(await view(SHARED_CONTRACT, "get_config"))}`);
