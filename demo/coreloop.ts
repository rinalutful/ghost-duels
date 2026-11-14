// `npm run coreloop`: the game's core loop and its main refusals on the COMMITTED contract wasm
// (res/ghost_duels.wasm, this source's build), with no Rust toolchain and no local node. The wasm
// runs in a small NEAR host for Node (demo/wasm/host.ts), one receipt at a time; the players fly the
// browser build of the game (res/ghost_sim_web.wasm) with an autopilot, as the testnet demo does.
//
// What it shows: a stake or a pot is locked before the cave exists; submit_run sends button changes
// and the contract re-flies them itself and pays in the same call; an edited score, a malformed log
// and a late submit are refused; a stranger can't race a duel; a session key can't spend past its
// cap or withdraw; the public ladder moves no money; and every yoctoNEAR is accounted for.
//
// What it doesn't: gas, the protocol's access-key rules, real accounts and exact storage prices
// aren't emulated (host.ts says how storage is counted). The contract's 40-odd unit tests, the
// property tests and the mutants (cargo, a few minutes to build) run in `npm run judge:full`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { autopilot, Sim } from "../web/src/sim.ts";
import { Contract, json, transferred, type Outcome } from "./wasm/host.ts";

const res = (f: string) => new URL(`../res/${f}`, import.meta.url);
/** The contract version of this source: "v4" unless res/deploy.json says otherwise. */
const SOURCE: string = existsSync(res("deploy.json")) ? JSON.parse(readFileSync(res("deploy.json"), "utf8")).source : "v4";
const NEAR = 10n ** 24n;
const milli = (n: number) => (NEAR / 1000n) * BigInt(n);
const near = (y: bigint | string) => `${(Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4)}`;
const GAME = "duels.test", HOUSE = "house.test", ALICE = "alice.test", BOB = "bob.test", CAROL = "carol.test", ALT = "alice-alt.test";

let passed = 0, failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`${ok ? "✓" : "✗"} ${what.padEnd(78)} ${detail}`);
};
const section = (s: string) => console.log(`\n${s}`);

const wasm = readFileSync(res("ghost_duels.wasm"));
const sim = await Sim.load(readFileSync(res("ghost_sim_web.wasm")));
const game = new Contract(GAME, wasm);
game.balance = 10n * NEAR; // what a deploy leaves on the account for its code
let now = 1_762_000_000_000;
let deposited = 0n, withdrawn = 0n;
/** A session key, as near-sdk sees it (curve byte + 32 bytes) and as JSON ("ed25519:<base58>"). */
const KEY = createHash("sha256").update("coreloop: a throwaway session key").digest();
const KEY_BORSH = Uint8Array.from([0, ...KEY]);
const b58 = (b: Uint8Array) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n), s = "";
  for (; n > 0n; n /= 58n) s = A[Number(n % 58n)] + s;
  return "1".repeat(b.findIndex((x) => x !== 0) === -1 ? b.length : b.findIndex((x) => x !== 0)) + s;
};
const KEY_JSON = `ed25519:${b58(KEY)}`;

/** One call. `yocto` 1 marks the account's full-access key; `key` signs with the session key. */
const call = (who: string, method: string, args: unknown, o: { deposit?: bigint; key?: boolean; results?: (Uint8Array | null)[]; as?: string } = {}): Outcome => {
  now += 1_200; // a block or so
  return game.call(method, args, { predecessor: o.as ?? who, deposit: o.deposit ?? 0n, timestampMs: now, signerPk: KEY_BORSH, results: o.results });
};
const must = (o: Outcome, what: string) => {
  if (!o.ok) throw new Error(`${what}: ${o.error}`);
  return o;
};
const refused = (what: string, o: Outcome, want: string) => check(what, !o.ok && o.error.includes(want), o.ok ? "ACCEPTED" : o.error.slice(0, 90));
const view = <T = any>(m: string, a: unknown = {}) => game.view<T>(m, a);
const bal = (who: string) => BigInt(view<string>("get_balance", { account_id: who }));
const ghost = (id: number) => view<any>("get_ghost", { ghost_id: id });
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const deposit = (who: string, amount: bigint) => {
  must(call(who, "deposit", {}, { deposit: amount }), "deposit");
  deposited += amount;
};
/** Fly a run's cave with the autopilot (it gives up at `quit` ticks). */
const fly = (run: { seed: string }, quit: number) => {
  const score = autopilot(sim, 0, unhex(run.seed), 24, 6, () => 0.5, 0, quit);
  return { log: sim.log(0), score };
};
type Run = { id: number; seed: string; status: string; note: string | null; deadline_ms: number; minted: number | null; replay: { score: number; via: string } | null };
const start = (who: string, args: unknown, o: { key?: boolean } = {}) => call(who, "start_run", args, { deposit: o.key ? 0n : 1n });
const submit = (who: string, run: Run, log: number[], claim: number) => call(who, "submit_run", { run_id: run.id, log, claimed_score: claim });
/** Start a race and fly it; `quit` decides how well. */
const race = (who: string, ghostId: number, quit: number, o: { key?: boolean } = {}) => {
  const run = json(must(start(who, { ghost_id: ghostId }, o), "start_run")) as Run;
  const f = fly(run, quit);
  return json(must(submit(who, run, f.log, f.score), "submit_run")) as Run;
};

console.log(`Ghost Duels' core loop on the committed wasm (${SOURCE} source, res/ghost_duels.wasm, ${wasm.length} bytes, sha256 ${createHash("sha256").update(wasm).digest("hex").slice(0, 12)}…), in a NEAR host for Node. Nothing leaves this machine.`);

section("1. A duel: the pot is locked before the cave exists; the contract re-flies the inputs and mints the ghost");
must(call(HOUSE, "new", { owner: HOUSE, mode: "OnChain", offchain_allowed: false }), "new");
for (const who of [ALICE, BOB, CAROL, ALT]) deposit(who, 3n * NEAR);
const POT = milli(500), STAKE = milli(100);
const a0 = bal(ALICE);
const q = json(must(start(ALICE, { qualify: { pot: String(POT), stake: String(STAKE), challengers: [BOB] } }), "qualifier")) as Run;
check("start_run locks alice's 0.5 NEAR pot and only then draws the cave's seed", a0 - bal(ALICE) >= POT && /^[0-9a-f]{64}$/.test(q.seed), `alice −${near(a0 - bal(ALICE))} (pot, reserve, storage); seed ${q.seed.slice(0, 10)}…`);
const flown = fly(q, 1100);
const minted = json(must(submit(ALICE, q, flown.log, flown.score), "submit")) as Run;
const G = minted.minted ?? 0;
check("submit_run sends button changes; the contract replays them and mints the ghost in the same call", minted.status === "Minted" && minted.replay?.score === flown.score && /on-chain/.test(minted.replay?.via ?? ""), `${flown.log.length} changes → ${minted.replay?.score} points; ${minted.note}`);
const g0 = ghost(G);
check("the ghost is a NEP-171 token alice owns, holding the pot and naming bob", view<any>("nft_token", { token_id: String(G) }).owner_id === ALICE && BigInt(g0.pot) === POT && g0.challengers.join() === BOB, `ghost #${G}: pot ${near(g0.pot)}, stake ${near(g0.stake)}`);

section("2. Refusals: a stranger, an edited score, a malformed log, a late submit");
refused("carol, whom alice didn't name, can't race the duel", start(CAROL, { ghost_id: G }), "private duel");
let run = json(must(start(BOB, { ghost_id: G }), "start")) as Run;
let f = fly(run, 200);
const cheat = json(must(submit(BOB, run, f.log, f.score + 500), "submit")) as Run;
check("bob claims 500 points more than he flew: refused by the replay, and the stake is forfeited", cheat.status === "Refused" && ghost(G).forfeits === 1, cheat.note ?? "");
run = json(must(start(BOB, { ghost_id: G }), "start")) as Run;
refused("a log whose ticks go backwards is refused (the run stays open)", submit(BOB, run, [30, 10], 5), "strictly increase");
now = run.deadline_ms + 1;
refused("…and after its 90 s deadline the same run can't be submitted", submit(BOB, run, [], 0), "too late");
const expired = json(must(call(CAROL, "expire_run", { run_id: run.id }), "expire_run")) as Run;
check("anyone closes the run that ran out of time: a forfeit", expired.status === "Expired" && ghost(G).forfeits === 2, expired.note ?? "");

section("3. Lose and win: the split, then the pot");
const [a1, h1, p1, b1] = [bal(ALICE), bal(HOUSE), BigInt(ghost(G).pot), bal(BOB)];
const lost = race(BOB, G, 200);
const [da, dh, dp] = [bal(ALICE) - a1, bal(HOUSE) - h1, BigInt(ghost(G).pot) - p1];
check("bob falls short: his 0.1 stake goes 70% to alice, 25% into the pot, 5% to the house, exactly", lost.status === "Lost" && da === (STAKE * 70n) / 100n && dp === (STAKE * 25n) / 100n && dh === (STAKE * 5n) / 100n, `${lost.note}`);
let won: Run | null = null;
for (let i = 0; i < 8 && !won; i++) {
  const pot = BigInt(ghost(G).pot), before = bal(BOB);
  const r = race(BOB, G, 3600);
  if (r.status === "Won") {
    won = r;
    check("bob beats the ghost's score: the contract pays him its whole pot in the same call", bal(BOB) - before > pot - milli(20) && BigInt(ghost(G).pot) === 0n && ghost(G).beaten === 1, `${r.note}; bob +${near(bal(BOB) - before)} (the pot, less his run's storage)`);
  }
}
if (!won) check("bob beats the ghost within 8 races", false, "the autopilot never beat it");
refused("a beaten ghost can't be raced until its owner refills it", start(BOB, { ghost_id: G }), "no pot");
void b1;

section("4. A session key: capped by the contract, and it can't take money out");
must(call(ALICE, "refill_ghost", { ghost_id: G, amount: String(POT) }, { deposit: 1n }), "refill");
refused("bob's session key, with no cap set, can't stake", start(BOB, { ghost_id: G }, { key: true }), "no spending cap");
must(call(BOB, "set_key_cap", { public_key: KEY_JSON, cap: String(milli(150)) }, { deposit: 1n }), "set_key_cap");
const kb = bal(BOB);
const keyed = race(BOB, G, 150, { key: true });
const spent = BigInt(view<any>("get_key_cap", { account_id: BOB, public_key: KEY_JSON }).spent);
check("capped at 0.15 NEAR it races with no deposit and no prompt; the key counts what the run cost", (keyed.status === "Lost" || keyed.status === "Won") && spent >= STAKE && spent === kb - bal(BOB), `${keyed.status}; the key has spent ${near(spent)}, bob's balance lost ${near(kb - bal(BOB))}`);
refused("…a second 0.1 stake would pass the cap: refused", start(BOB, { ghost_id: G }, { key: true }), "this key's cap");
refused("the session key can't name who races bob's money (a duel qualifier needs the full-access key)", call(BOB, "start_run", { qualify: { pot: String(milli(200)), stake: String(milli(20)), challengers: [CAROL] } }), "full-access key");
refused("…and can't withdraw: that needs 1 yoctoNEAR, which only a full-access key can attach", call(BOB, "withdraw", {}), "1 yoctoNEAR");
const w = must(call(BOB, "withdraw", { amount: String(NEAR) }, { deposit: 1n }), "withdraw");
withdrawn += NEAR;
check("bob's full-access key withdraws 1 NEAR: the contract schedules the transfer to bob", transferred(w.receipts, BOB) === NEAR + 1n, `transfer of ${near(transferred(w.receipts, BOB))} NEAR to ${BOB}`);

section("5. The public ladder: anyone races, the record counts, no money moves");
const lq = json(must(start(CAROL, { qualify: { pot: "0", stake: "0" } }, { key: false }), "ladder qualifier")) as Run;
const lf = fly(lq, 700);
const L = (json(must(submit(CAROL, lq, lf.log, lf.score), "submit")) as Run).minted ?? 0;
const [c2, h2] = [bal(CAROL), bal(HOUSE)];
const lr = race(ALT, L, 300);
const lg = ghost(L);
check("alice-alt, whom nobody named, races carol's ladder ghost; carol and the house get nothing", (lr.status === "Won" || lr.status === "Lost") && bal(CAROL) === c2 && bal(HOUSE) === h2 && lg.pot === "0" && lg.defended + lg.beaten === 1, `${lr.note}`);

if (SOURCE === "v4") {
  section("6. A stated limit of v4 (docs/decisions/0022): the ghost's owner can take the pot first");
  const target = ghost(G).score;
  // bob starts a race he will win; alice names a second account mid-race; it wins first.
  let rb: Run | null = null, fb = { log: [] as number[], score: 0 };
  for (let i = 0; i < 8 && !rb; i++) {
    const r = json(must(start(BOB, { ghost_id: G }), "start")) as Run;
    const t = fly(r, 3600);
    if (t.score > target) [rb, fb] = [r, t];
    else must(submit(BOB, r, t.log, t.score), "submit");
  }
  const named = call(ALICE, "set_challengers", { ghost_id: G, challengers: [BOB, ALT] }, { deposit: 1n });
  let altWon = false;
  for (let i = 0; i < 8 && named.ok && !altWon; i++) altWon = race(ALT, G, 3600).status === "Won";
  const bb = bal(BOB);
  const late = rb ? (json(must(submit(BOB, rb, fb.log, fb.score), "submit")) as Run) : null;
  check("NOT refused on v4: alice names her second account mid-race, it wins, and bob, who also won, gets only his stake back", named.ok && altWon && /already won/.test(late?.note ?? "") && bal(BOB) - bb < milli(150), late?.note ?? "bob never drew a winning cave");
} else {
  section("6. v5 (docs/decisions/0023): the pot a challenger started for is there when they land; a failed withdrawal comes back");
  const target = ghost(G).score;
  // alice names a second account of hers in advance, beside bob.
  must(call(ALICE, "set_challengers", { ghost_id: G, challengers: [BOB, ALT] }, { deposit: 1n }), "set_challengers");
  let rb: Run | null = null, fb = { log: [] as number[], score: 0 };
  for (let i = 0; i < 8 && !rb; i++) {
    const r = json(must(start(BOB, { ghost_id: G }), "start")) as Run;
    const t = fly(r, 3600);
    if (t.score > target) [rb, fb] = [r, t];
    else must(submit(BOB, r, t.log, t.score), "submit");
  }
  refused("while bob races, alice's second account can't start a race to win the pot first", start(ALT, { ghost_id: G }), "one race at a time");
  refused("…and alice can't change who may race the ghost", call(ALICE, "set_challengers", { ghost_id: G, challengers: [BOB, ALT, CAROL] }, { deposit: 1n }), "a race is in flight");
  const pot = BigInt(ghost(G).pot), bb = bal(BOB);
  const land = rb ? (json(must(submit(BOB, rb, fb.log, fb.score), "submit")) as Run) : null;
  check("bob lands and takes the pot he started for", land?.status === "Won" && bal(BOB) - bb > pot - milli(20), land?.note ?? "bob never drew a winning cave");
  // The pot bob was shown can be won and refilled smaller before his next start lands: min_pot
  // (the pot the page showed him) refuses that start, and nothing is staked.
  if (BigInt(ghost(G).pot) === 0n) must(call(ALICE, "refill_ghost", { ghost_id: G, amount: String(STAKE) }, { deposit: 1n }), "refill");
  const shown = String(POT), bs = bal(BOB);
  const swapped = call(BOB, "start_run", { ghost_id: G, min_pot: shown }, { deposit: 1n });
  check("alice refills the won pot with a fifth of it: bob's start, asking for the pot he was shown, is refused", !swapped.ok && swapped.error.includes("you were shown") && bal(BOB) === bs && BigInt(ghost(G).pot) < POT, swapped.ok ? "ACCEPTED" : swapped.error.slice(0, 100));
  // A withdrawal whose transfer fails: the callback credits it back.
  const cb = bal(CAROL);
  must(call(CAROL, "withdraw", { amount: String(NEAR) }, { deposit: 1n }), "withdraw");
  const back = must(call(GAME, "on_withdraw", { account_id: CAROL, amount: String(NEAR) }, { results: [null] }), "on_withdraw");
  check("carol's withdrawal fails to arrive: on_withdraw puts the 1 NEAR back in her balance", json(back) === false && bal(CAROL) === cb, `carol ${near(cb)} → ${near(bal(CAROL))}`);
  refused("…and only the contract itself can call that callback", call(CAROL, "on_withdraw", { account_id: CAROL, amount: String(NEAR) }, { results: [null] }), "private");
}

section("7. The books");
const players = [HOUSE, ALICE, BOB, CAROL, ALT];
const ghosts = view<any[]>("get_ghosts", { limit: 100 });
const held = players.reduce((n, p) => n + bal(p), 0n) + ghosts.reduce((n, x) => n + BigInt(x.pot), 0n);
const paid = BigInt(view<any>("get_storage").paid);
const open = view<any[]>("get_runs", { limit: 100 }).filter((r) => r.status === "Playing" || r.status === "Replaying").length;
check("balances + pots + storage paid = deposits − withdrawals, to the yocto, with no run in flight", open === 0 && held + paid === deposited - withdrawn, `${near(held)} + ${near(paid)} = ${near(deposited)} − ${near(withdrawn)}`);

console.log(failed === 0 ? `\nAll ${passed} core-loop checks passed.` : `\n${failed} of ${passed + failed} core-loop checks failed.`);
process.exit(failed === 0 ? 0 : 1);
