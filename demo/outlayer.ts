// `npm run outlayer`: THE OWNER'S STEP (CLAUDE.md rule 4): one real replay through OutLayer on a
// separate deploy, since v4 is on-chain only on purpose (0014, 0020). Prepared, not run: it needs
//   - about 3.7 testnet NEAR on V4_FUNDER for a second deploy (the funder has less; a second faucet
//     draw is the owner's call),
//   - the replay job at a public https URL (the repo public: the URL is raw.githubusercontent.com at a
//     commit), and
//   - OutLayer's terms checked: whether a WasmUrl job needs an outlayer.ai sign-up or a payment
//     (unverified; decision 0003).
// Every run refuses without CONFIRM_OUTLAYER=1, and refuses to touch v4.
//   CONFIRM_OUTLAYER=1 npm run outlayer -- --deploy-side      ol.<funder>: offchain_allowed true, locked
//   CONFIRM_OUTLAYER=1 npm run outlayer -- <40-hex commit>    point it at OutLayer with that commit's job
//   GD=ol.<funder> npm run demo -- --shared                   settles through OutLayer's workers; a
//                                                             failed or missing replay falls back on-chain (0012)
//   CONFIRM_OUTLAYER=1 npm run outlayer -- --back             back to OnChain mode
// Then record the transactions in docs/evidence/outlayer-testnet.txt and change the README's
// SIMULATED line to say where it ran for real.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actions, KeyPair, type KeyPairString } from "near-api-js";
import { N, call, exists, keyed, sendActions, txLink, view } from "./src/near.ts";
import { keychainLoad, keychainSet } from "./src/keys.ts";
import { SHARED_CONTRACT, V4_FUNDER } from "./src/world.ts";

if (process.env.CONFIRM_OUTLAYER !== "1") throw new Error("the owner's step: needs CONFIRM_OUTLAYER=1 (see the comment at the top of demo/outlayer.ts)");
const SIDE = `ol.${V4_FUNDER}`;
const contract = process.env.GD ?? SIDE;
if (contract === SHARED_CONTRACT) throw new Error(`${SHARED_CONTRACT} is on-chain only and locked: use the side deploy ${SIDE}`);
const owner = keyed(V4_FUNDER);
const arg = process.argv[2];
const must = async (method: string, args: Record<string, unknown>) => {
  const r = await call(owner, contract, method, args, 0n, 30n);
  if (!r.ok) throw new Error(`${method}: ${r.reason}`);
  console.log(`${method}: ${txLink(r.tx)}`);
};

if (arg === "--deploy-side") {
  const wasm = readFileSync(new URL("../res/ghost_duels.wasm", import.meta.url));
  if (!(await exists(SIDE))) {
    const key = KeyPair.fromRandom("ed25519");
    keychainSet(SIDE, key.toString());
    const milli = (BigInt(wasm.length) * 10n ** 19n) / 10n ** 21n + 300n;
    console.log(`creating ${SIDE}: ${txLink(await sendActions(owner, SIDE, [actions.createAccount(), actions.transfer(milli * 10n ** 21n), actions.addFullAccessKey(key.getPublicKey())]))}`);
  }
  const pk = KeyPair.fromString(keychainLoad(SIDE) as KeyPairString).getPublicKey();
  const tx = await sendActions(keyed(SIDE), SIDE, [actions.deployContract(wasm), actions.functionCall("new", { owner: V4_FUNDER, mode: "OnChain", offchain_allowed: true }, 30n * 10n ** 12n, 0n), actions.deleteKey(pk)]);
  console.log(`deployed ${SIDE} (offchain_allowed: true, owner ${V4_FUNDER}) and deleted its key: ${txLink(tx)}`);
  process.exit(0);
}
if (arg === "--back") {
  await must("set_params", { rake_bps: 500, pot_bps: 2500, abandon_bps: 2000, replay_fee: N("0"), run_secs: 90, replay_timeout_secs: 300, pot_lock_secs: 86400, min_ghost_score: 100, min_stake: N("0.01") });
  await must("set_mode", { mode: "OnChain" });
  process.exit(0);
}
if (!arg || !/^[0-9a-f]{40}$/.test(arg)) throw new Error("usage: CONFIRM_OUTLAYER=1 npm run outlayer -- <full 40-hex commit of the public repo> | --deploy-side | --back");
const cfg = await view<{ offchain_allowed: boolean }>(contract, "get_config");
if (!cfg.offchain_allowed) throw new Error(`${contract} was deployed on-chain only`);
const url = `https://raw.githubusercontent.com/rinalutful/ghost-duels/${arg}/res/ghost_replay_job.wasm`;
const local = createHash("sha256").update(readFileSync(new URL("../res/ghost_replay_job.wasm", import.meta.url))).digest("hex");
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is the repo public?)`);
const remote = createHash("sha256").update(new Uint8Array(await res.arrayBuffer())).digest("hex");
if (remote !== local) throw new Error(`the job at ${arg} (${remote}) isn't res/ghost_replay_job.wasm (${local})`);
await must("set_outlayer", { outlayer: { contract: "outlayer.testnet", wasm_url: url, wasm_hash: local, max_instructions: "2000000000", max_execution_seconds: "20" } });
await must("set_params", { rake_bps: 500, pot_bps: 2500, abandon_bps: 2000, replay_fee: N("0.02"), run_secs: 90, replay_timeout_secs: 600, pot_lock_secs: 86400, min_ghost_score: 100, min_stake: N("0.01") });
await must("set_mode", { mode: "OutLayer" });
console.log(`${contract} now replays through OutLayer with ${url}`);
