// `CONFIRM_V5=1 V5_FUNDER=<account> npm run deploy-v5`: deploy this source (v5, docs/decisions/0023)
// to a NEW testnet account, locked exactly as v4 is, and point the repo at it. v4 and everything
// before it are left as they are. Nothing here runs without CONFIRM_V5=1, and it refuses to run
// twice (once res/deploy.json says v5).
//
// The funder is an account the repository's owner provides: about 4.2 NEAR for the contract (its
// code's storage, 1 NEAR per 100 KB, plus 0.4) and about 2 more for the demo players that
// `npm run demo -- --shared` makes under it. Its key is read from the OS keyring, or from the
// environment variable KEY_<account id with dots and dashes as underscores>.
//
//   1. The funder creates v5.<funder> with enough for its code, and a temporary full-access key for
//      it that goes to the keyring first (stored, then read back, before the account exists).
//   2. One transaction, signed by that key: deploy res/ghost_duels.wasm (checked against
//      res/SHA256SUMS), new(owner: the funder, mode: OnChain, offchain_allowed: false), delete the key.
//   3. It checks the result on chain (the code hash is the file's, no access keys, OnChain only),
//      and only then rewrites res/deploy.json and copies the build to res/v5/. The page, the demos
//      and `npm run verify` read that file, so they follow.
// Then it prints what to run next. It does not edit the README.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { actions, baseEncode, KeyPair, type KeyPairString } from "near-api-js";
import { balance, exists, keyed, near, provider, sendActions, txLink, view } from "./src/near.ts";
import { keychainLoad, keychainSet } from "./src/keys.ts";
import { DEPLOY } from "./src/world.ts";

if (process.env.CONFIRM_V5 !== "1") throw new Error("this deploys a new contract on testnet and repoints the repo: run it with CONFIRM_V5=1 (and V5_FUNDER=<account>)");
if (DEPLOY.version === "v5") throw new Error(`res/deploy.json already names v5 (${DEPLOY.contract}): nothing to do`);
const FUNDER = process.env.V5_FUNDER;
if (!FUNDER) throw new Error("V5_FUNDER=<a testnet account with about 6.5 NEAR whose key is in the keyring or in KEY_<id>>");
const CONTRACT = `v5.${FUNDER}`;
const resUrl = (f: string) => new URL(`../res/${f}`, import.meta.url);
const wasm = readFileSync(resUrl("ghost_duels.wasm"));
const hex = createHash("sha256").update(wasm).digest("hex");
const sums = readFileSync(resUrl("SHA256SUMS"), "utf8");
if (!sums.split("\n").some((l) => l.startsWith(hex) && l.trim().endsWith("ghost_duels.wasm"))) throw new Error("res/ghost_duels.wasm doesn't match res/SHA256SUMS: rebuild with scripts/build-wasm.sh --contracts");

const funder = keyed(FUNDER);
const have = await balance(funder.id);
// The code's storage (1 NEAR per 100 KB) plus 0.4 for the state and the first transactions.
const milli = (BigInt(wasm.length) * 10n ** 19n) / 10n ** 21n + 400n;
console.log(`funder: ${funder.id} (${near(have)}); ${CONTRACT} needs ${near(milli * 10n ** 21n)}`);
if (!(await exists(CONTRACT))) {
  if (have < (milli + 300n) * 10n ** 21n) throw new Error(`${funder.id} has ${near(have)}: too little to create ${CONTRACT}`);
  const key = KeyPair.fromRandom("ed25519");
  keychainSet(CONTRACT, key.toString()); // stored and read back before the account exists
  const tx = await sendActions(funder, CONTRACT, [actions.createAccount(), actions.transfer(milli * 10n ** 21n), actions.addFullAccessKey(key.getPublicKey())]);
  console.log(`${funder.id} created ${CONTRACT}: ${txLink(tx)}`);
}
if (!(await view(CONTRACT, "get_config").then(() => true, () => false))) {
  const v5 = keyed(CONTRACT);
  const pk = KeyPair.fromString(keychainLoad(CONTRACT) as KeyPairString).getPublicKey();
  const tx = await sendActions(v5, CONTRACT, [
    actions.deployContract(wasm),
    actions.functionCall("new", { owner: FUNDER, mode: "OnChain", offchain_allowed: false }, 30n * 10n ** 12n, 0n),
    actions.deleteKey(pk),
  ]);
  console.log(`deployed ${CONTRACT} (OnChain only, owner ${FUNDER}) and deleted its only key: ${txLink(tx)}`);
}
// Check it on chain before anything in the repo points at it.
const acct = await provider.viewAccount({ accountId: CONTRACT });
const keys = await provider.viewAccessKeyList({ accountId: CONTRACT });
const cfg = await view<{ mode: string; offchain_allowed: boolean; owner: string }>(CONTRACT, "get_config");
const want = baseEncode(createHash("sha256").update(wasm).digest());
if (acct.code_hash !== want || keys.keys.length !== 0 || cfg.mode !== "OnChain" || cfg.offchain_allowed || cfg.owner !== FUNDER) {
  throw new Error(`${CONTRACT} is not as intended (code ${acct.code_hash}, wanted ${want}; ${keys.keys.length} keys; ${JSON.stringify(cfg)}): the repo was NOT repointed`);
}
mkdirSync(resUrl("v5/"), { recursive: true });
writeFileSync(resUrl("v5/ghost_duels.wasm"), wasm);
writeFileSync(resUrl("v5/SHA256SUMS"), `${hex}  ghost_duels.wasm\n`);
writeFileSync(resUrl("deploy.json"), `${JSON.stringify({ version: "v5", contract: CONTRACT, funder: FUNDER, wasm: "ghost_duels.wasm", source: "v5" }, null, 2)}\n`);
console.log(`\n${CONTRACT}: ${near(await balance(CONTRACT))}, 0 access keys, code ${acct.code_hash}. res/deploy.json now names it.`);
console.log(`Next, in this order (each prints its own result):
  npm run verify                                  expect: All 13 checks passed. (v5, and v4 to v1 untouched)
  npm run demo -- --shared > docs/evidence/testnet-demo-v5.txt
  npm run cheat -- --shared > docs/evidence/testnet-cheat-v5.txt
  npm run build:web && npm run page-test && npm run page-e2e > docs/evidence/page-e2e-v5.txt
Then, in README.md: the Status block and "On testnet" name ${CONTRACT} and its deploy transaction above,
"A duel's owner can take the pot first" moves from a limit of the live contract to history (docs/history.md),
and commit res/deploy.json, res/v5/ and the evidence files.`);
