// What the testnet demo, the cheat demo and the runner share: a deploy of Ghost Duels (a judge's own,
// from one faucet account, or the owner's shared one), its players, and the registered runner.
//
// The players fly the BROWSER build of the game (res/ghost_sim_web.wasm, via web/src/sim.ts), with an
// autopilot standing in for a human; the wasm records the button changes exactly as the page does.
// The runner replays each submitted run with the wasip2 job under wasmtime (res/ghost_replay_job.wasm)
// and hands the result to the contract: tonight's stand-in for an OutLayer TEE worker. It is a
// trusted, registered account, NOT an attested enclave, and the contract says so in every replay.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actions, KeyPair, type KeyPairString } from "near-api-js";
import { autopilot, Sim } from "../../web/src/sim.ts";
import { faucetAccount } from "./faucet.ts";
import { keychainHas } from "./keys.ts";
import { N, addSessionKey, balance, call, exists, keyed, near, provider, send, sendActions, subAccount, txLink, view, withKey, type Named, type Result } from "./near.ts";
import { runJob, wasmtimeVersion } from "./replay.ts";

const TGAS = 10n ** 12n;
const res = (f: string) => readFileSync(new URL(`../../res/${f}`, import.meta.url));
/** The repo's first funder: owner of v1, v2 and v3, and v1's parent. Its key is in the owner's macOS
 *  keychain; nothing here signs with it any more. */
export const REPO_FUNDER = "ghost-duels-jbx5v9.testnet";
/** v3 (docs/decisions/0014): on-chain only, no access keys, v3's source. History since v4. */
export const V3_CONTRACT = "v3.gd-v2-59lavk.testnet";
/** v4's funder and owner (the house), and its demo players' parent: one faucet draw
 *  (2026-11-10, `npm run funder`), its key in the builder's OS keyring. */
export const V4_FUNDER = "near-ghost-duels-rywu8u.testnet";
/** v4 (docs/decisions/0020): the current source, on-chain only, no access keys. */
/** The live deploy the page, the demos and `npm run verify` use: res/deploy.json. `version` is the
 *  contract version deployed there, `wasm` its build under res/, `source` the version of this
 *  source. They differ while this source's build (res/ghost_duels.wasm) isn't deployed;
 *  `npm run deploy-v5` deploys it to a new locked account and rewrites that file. */
export const DEPLOY = JSON.parse(res("deploy.json").toString()) as { version: string; contract: string; funder: string; wasm: string; source: string };
export const SHARED_CONTRACT = process.env.GD_SHARED ?? DEPLOY.contract;
export const SHARED_FUNDER = process.env.FUNDER_ID ?? DEPLOY.funder;
/** The methods a session key may call. Withdraw, set_key_cap and nft_transfer need a full-access key. */
export const SESSION_METHODS = ["start_run", "submit_run", "expire_run", "refill_ghost"];

export type Run = { id: number; seed: string; status: string; note: string | null; stake: string; minted: number | null; replay?: { score: number; via: string } | null };
export type Ghost = { id: number; owner: string; score: number; pot: string; stake: string; defended: number; forfeits: number; beaten: number; best_challenge: number; earned: string; grown: string; raked: string; challengers: string[] };

export class Checks {
  failed = 0;
  passed = 0;
  check(what: string, ok: boolean, detail = "") {
    ok ? this.passed++ : this.failed++;
    console.log(`${ok ? "✓" : "✗"} ${what.padEnd(64)} ${detail}`);
  }
}

export type World = {
  contract: string;
  funder: Named;
  /** The contract's owner (the house): the rake accrues here. */
  owner: Named;
  runner: Named;
  alice: Named;
  bob: Named;
  /** bob's app: a function-call key that may only call the game's methods. */
  bobApp: Named;
  /** Its secret key (to read its cap in the cheat demo). */
  bobAppKey: string;
  aliceApp: Named;
  sim: Sim;
};

/**
 * A judge's world (`fresh`): one faucet account, its keys in this process only, a contract and
 * players under it. The owner's (`shared`): the keychain funder and `duels.<funder>`, created once.
 */
export async function world(mode: "fresh" | "shared"): Promise<World> {
  // v4 replays on-chain, so wasmtime is only needed for a Runner-mode deploy (runnerPass).
  let wt = "not installed (not needed: the contract replays on-chain)";
  try {
    wt = wasmtimeVersion();
  } catch {}
  console.log(`replay job for Runner-mode deploys: res/ghost_replay_job.wasm under wasmtime: ${wt}`);
  let funderId: string;
  if (mode === "fresh") {
    process.env.NO_KEYCHAIN = "1";
    funderId = await faucetAccount("gd-judge");
    console.log(`faucet account ${funderId} (10 testnet NEAR; its key lives in this process only)`);
  } else {
    funderId = SHARED_FUNDER;
    if (!keychainHas(funderId)) throw new Error(`--shared needs ${funderId}'s key in the keychain; judges run plain \`npm run demo\``);
  }
  const funder = keyed(funderId);
  const contract = process.env.GD ?? (mode === "shared" ? SHARED_CONTRACT : `duels.${funderId}`);
  // The house's account: v4's owner is its funder; a fresh deploy's is the faucet account.
  const owner = funder;
  const ensure = async (name: string, amount: string) => {
    const id = `${name}.${funderId}`;
    if (await exists(id)) return keyed(id);
    const a = await subAccount(funder, name, amount);
    console.log(`created ${id} with ${amount} NEAR`);
    return a;
  };
  // A fresh run deploys its own contract under the faucet account; the shared v4 exists already
  // (npm run deploy-v4).
  const gd = mode === "fresh" ? await ensure("duels", "3.9") : keyed(contract);
  // v3 replays on-chain only, so no runner account is created; `runner` is kept for Runner-mode deploys.
  const runner = funder;
  const alice = await ensure("alice", "1.5");
  const bob = await ensure("bob", "1.5");

  // Deploy (refusing a wasm whose hash isn't in res/SHA256SUMS) and set up, each step once.
  const sums = Object.fromEntries(res("SHA256SUMS").toString().trim().split("\n").map((l: string) => l.split(/\s+/).reverse()));
  const wasm = res("ghost_duels.wasm");
  if (createHash("sha256").update(wasm).digest("hex") !== sums["ghost_duels.wasm"]) throw new Error("res/ghost_duels.wasm doesn't match res/SHA256SUMS");
  if (!(await view(contract, "get_config").then(() => true, () => false))) {
    const tx = await sendActions(gd, contract, [actions.deployContract(wasm), actions.functionCall("new", { owner: owner.id, mode: "OnChain", offchain_allowed: false }, 30n * TGAS, 0n)]);
    console.log(`deployed ${contract} (on-chain only: the contract replays every run itself): ${txLink(tx)}`);
  }
  // In-game balances, from each player's full-access key (the one step a wallet would confirm).
  for (const [p, amt] of [[alice, "1.1"], [bob, "1.1"]] as const) {
    const bal = BigInt(await view<string>(contract, "get_balance", { account_id: p.id }));
    if (bal < BigInt(N("0.6"))) {
      // A re-run of the shared demo can find a player's wallet spent: its funder tops it up first.
      if ((await balance(p.id)) < BigInt(N(amt)) + BigInt(N("0.3"))) {
        await send(funder, p.id, "1.4");
        console.log(`${funder.id} topped up ${p.id} with 1.4 NEAR`);
      }
      const r = await call(p, contract, "deposit", {}, BigInt(N(amt)), 30n);
      console.log(`${p.id} deposits ${amt} NEAR into the game: ${txLink(r.tx)}`);
    }
  }
  // Each app gets a session key, and the player caps what it may put at risk (one full-access call).
  const session = async (p: Named) => {
    const key = await addSessionKey(p, contract, SESSION_METHODS, "0.25");
    must(await call(p, contract, "set_key_cap", { public_key: KeyPair.fromString(key as KeyPairString).getPublicKey().toString(), cap: N("1") }, 1n, 30n), "set_key_cap");
    return { app: withKey(p.id, key), key };
  };
  const aliceApp = (await session(alice)).app;
  const { app: bobApp, key: bobAppKey } = await session(bob);
  console.log(`alice's and bob's apps each hold a session key: only ${SESSION_METHODS.join(", ")}; no deposits; at most 1 NEAR at risk each\n`);
  return { contract, funder, owner, runner, alice, bob, aliceApp, bobApp, bobAppKey, sim: await Sim.load(res("ghost_sim_web.wasm")) };
}

function must(r: Result, what: string): unknown {
  if (!r.ok) throw new Error(`${what}: ${r.reason}`);
  return r.value;
}

const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/** Fly a run in the browser build. `skill` picks the autopilot: "weak" gives up early. */
export function fly(w: World, seed: string, skill: "weak" | "ok" | "strong"): { log: number[]; score: number } {
  const [look, lead, quit] = skill === "weak" ? [24, 6, 260] : skill === "ok" ? [24, 6, 1100] : [24, 6, 3600];
  const score = autopilot(w.sim, 0, unhex(seed), look, lead, () => 0.5, 0, quit);
  return { log: w.sim.log(0), score };
}

/** The registered runner: replay every pending run with the wasip2 job, hand in the result. */
export async function runnerPass(w: { contract: string; runner: Named }, quiet = false): Promise<Result[]> {
  const pending = await view<{ run_id: number; seed: string; log: number[]; log_hash: string }[]>(w.contract, "pending_replays", {});
  if (pending.length) wasmtimeVersion(); // throws, saying how to install it
  const out: Result[] = [];
  for (const p of pending) {
    const result = runJob({ seed: p.seed, log: p.log });
    const r = await call(w.runner, w.contract, "submit_replay", { run_id: p.run_id, result }, 0n, 60n);
    if (!quiet) console.log(`  runner replayed run ${p.run_id} under wasmtime: score ${result.score}, state ${result.final_state_hash.slice(0, 16)}… ${txLink(r.tx)}`);
    out.push(r);
  }
  return out;
}

export const getRun = (w: World, id: number) => view<Run>(w.contract, "get_run", { run_id: id });
export const getGhost = (w: World, id: number) => view<Ghost>(w.contract, "get_ghost", { ghost_id: id });
export const balanceOf = async (w: World, who: string) => BigInt(await view<string>(w.contract, "get_balance", { account_id: who }));

/** Start, fly, submit through `app`, then let the runner settle (in Runner mode). `claim` overrides the
 *  score sent; `qualify` makes it a qualifier (pot and stake locked now, a ghost if it scores 100+).
 *  A staked qualifier names its challengers (a private duel, 0019): that start is signed with the
 *  player's full-access key and 1 yoctoNEAR, so pass the player there, not its app. */
export async function play(w: World, app: Named, ghost: number | null, skill: "weak" | "ok" | "strong", claim?: (score: number) => number, logOverride?: number[], qualify?: { pot: string; stake: string; challengers?: string[] }) {
  const s = await call(app, w.contract, "start_run", { ghost_id: ghost, qualify: qualify ?? null }, qualify?.challengers?.length ? 1n : 0n, 50n);
  if (!s.ok) throw new Error(`start_run: ${s.reason}`);
  const run = s.value as Run;
  const flown = fly(w, run.seed, skill);
  const log = logOverride ?? flown.log;
  const claimed = claim ? claim(flown.score) : flown.score;
  const what = ghost ? ` against ghost #${ghost}` : !qualify ? "" : BigInt(qualify.pot) > 0n ? ` as a qualifier for a private duel with ${qualify.challengers?.map((c) => c.split(".")[0]).join(", ")} (pot ${near(qualify.pot)} locked before the cave exists)` : " as a public-ladder qualifier (no pot, no stake)";
  console.log(`  ${app.id.split(".")[0]} started run ${run.id}${what} (seed ${run.seed.slice(0, 12)}…): ${txLink(s.tx)}`);
  // OutLayer mode needs room for request_execution, its yield and our callback (300 Tgas, which
  // reserves ~0.3 NEAR up front); the other modes fit in 100.
  const mode = (await view<{ mode: string }>(w.contract, "get_config")).mode;
  const sub = await call(app, w.contract, "submit_run", { run_id: run.id, log, claimed_score: claimed }, 0n, mode === "OutLayer" ? 300n : 100n);
  // A retried send can find its first attempt already landed: the run's status below decides.
  if (!sub.ok && !/already submitted or settled/.test(sub.reason ?? "")) throw new Error(`submit_run: ${sub.reason}`);
  console.log(`  flew ${flown.score} points in the browser build; submitted ${log.length} button changes claiming ${claimed}: ${txLink(sub.tx)}`);
  await runnerPass(w);
  // Runner and on-chain modes settle by now; OutLayer settles when the TEE worker resumes the yield.
  let settled = await getRun(w, run.id);
  for (let i = 0; i < 90 && settled.status === "Replaying"; i++) {
    if (i === 0) console.log("  waiting for the replay to come back…");
    await new Promise((ok) => setTimeout(ok, 2000));
    settled = await getRun(w, run.id);
  }
  return { run: settled, log, score: flown.score, claimed };
}

export { near, provider };
