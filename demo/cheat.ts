// `npm run cheat`: every way to fake a run or abuse a key, on NEAR testnet, each refused. Sets up like
// `npm run demo` (one faucet account, its own v4 deploy, two players with capped session keys), mints
// alice's ghost as a private duel naming bob, then:
//   - bob: an edited score (a weak run that claims more than the ghost's score);
//   - bob: the champion's own inputs, copied onto his cave (a log that doesn't reproduce the claim);
//   - a malformed log; someone else's run; posing as a runner;
//   - bob's app's session key moving money out (withdraw), trading a ghost, naming who may race his
//     money, or staking past its cap;
//   - an account alice never named racing her ghost.
// `npm run cheat -- --shared` runs it on the live v4.
import { Checks, balanceOf, getGhost, near, play, world } from "./src/world.ts";
import { KeyPair, type KeyPairString } from "near-api-js";
import { N, call, view } from "./src/near.ts";

const w = await world(process.argv.includes("--shared") ? "shared" : "fresh");
const c = new Checks();

console.log("setup: alice flies a qualifier; it becomes a ghost");
const q = await play(w, w.alice, null, "ok", undefined, undefined, { pot: N("0.3"), stake: N("0.05"), challengers: [w.bob.id] });
if (q.run.status !== "Minted") throw new Error(`qualifier: ${q.run.note}`);
const gid = q.run.minted!;
const ghost = await getGhost(w, gid);
console.log(`  ghost #${gid}: ${ghost.score} points, pot ${near(ghost.pot)}\n`);

console.log("1. an edited score");
const a0 = await balanceOf(w, w.alice.id);
const e = await play(w, w.bobApp, gid, "weak", () => ghost.score + 100);
c.check(`bob flies ${e.score} and claims ${e.claimed}: refused`, e.run.status === "Refused", e.run.note ?? "");
c.check("…his stake is kept (a forfeit, not a defence); the pot only grows", (await balanceOf(w, w.alice.id)) > a0 && BigInt((await getGhost(w, gid)).pot) > BigInt(ghost.pot), "");

console.log("\n2. the champion's inputs, copied onto another cave");
const gl = await view<{ log: number[] }>(w.contract, "get_ghost_log", { ghost_id: gid });
const cp = await play(w, w.bobApp, gid, "weak", () => ghost.score + 1, gl.log);
c.check(`bob submits ghost #${gid}'s ${gl.log.length} button changes claiming ${ghost.score + 1}: refused`, cp.run.status === "Refused", cp.run.note ?? "");

console.log("\n3. a malformed log, someone else's run, a fake runner");
const s = await call(w.bobApp, w.contract, "start_run", { ghost_id: null }, 0n, 50n);
const run = s.value as { id: number; seed: string };
let r = await call(w.bobApp, w.contract, "submit_run", { run_id: run.id, log: [40, 20], claimed_score: 5 }, 0n, 100n);
c.check("a log whose ticks go backwards is refused at submit", !r.ok && /strictly increase/.test(r.reason ?? ""), r.reason);
r = await call(w.aliceApp, w.contract, "submit_run", { run_id: run.id, log: [], claimed_score: 7 }, 0n, 100n);
c.check("alice can't submit bob's run", !r.ok && /not your run/.test(r.reason ?? ""), r.reason);
r = await call(w.alice, w.contract, "submit_replay", { run_id: run.id, result: { score: 9999, metres: 1, gems: 0, ticks: 1, survived: true, final_state_hash: "00".repeat(32), log_hash: "00".repeat(32) } }, 0n, 50n);
c.check("alice posing as a runner (a made-up 9999) is refused", !r.ok && /runner/.test(r.reason ?? ""), r.reason);
await call(w.bobApp, w.contract, "submit_run", { run_id: run.id, log: [], claimed_score: 7 }, 0n, 100n);

console.log("\n4. the session key moving money");
r = await call(w.bobApp, w.contract, "withdraw", {}, 1n, 30n);
c.check("bob's app can't withdraw (a function-call key attaches no deposit)", !r.ok, (r.reason ?? "").slice(0, 70));
r = await call(w.bobApp, w.contract, "nft_transfer", { receiver_id: w.bob.id, token_id: String(gid) }, 0n, 30n);
c.check("…nor call a method outside the game's (nft_transfer)", !r.ok, (r.reason ?? "").slice(0, 70));
r = await call(w.bobApp, w.contract, "start_run", { qualify: { pot: N("0.2"), stake: N("0.02"), challengers: [w.alice.id] } }, 0n, 50n);
c.check("…nor stake bob's money on a ghost naming who may race it (a thief would name himself)", !r.ok && /needs your full-access key/.test(r.reason ?? ""), r.reason);
// A challenge bob's balance covers but his key's remaining cap doesn't: only the cap can refuse it.
const pk = KeyPair.fromString(w.bobAppKey as KeyPairString).getPublicKey().toString();
const kc0 = await view<{ cap: string; spent: string }>(w.contract, "get_key_cap", { account_id: w.bob.id, public_key: pk });
const cap = BigInt(kc0.spent) + BigInt(N("0.03")); // bob keeps his app on a short leash: 0.03 more than it has used
await call(w.bob, w.contract, "set_key_cap", { public_key: pk, cap: cap.toString() }, 1n, 30n);
if ((await balanceOf(w, w.bob.id)) < BigInt(N("0.1"))) throw new Error("bob's balance is too small to test the cap");
r = await call(w.bobApp, w.contract, "start_run", { ghost_id: gid }, 0n, 50n);
c.check(`…nor stake past the cap bob set for it (${near(cap)})`, !r.ok && /this key's cap/.test(r.reason ?? ""), r.reason);

console.log("\n5. an account alice never named races her ghost");
r = await call(w.funder, w.contract, "start_run", { ghost_id: gid }, 1n, 50n);
c.check(`${w.funder.id.split(".")[0]} is refused: staked play is a private duel`, !r.ok && /private duel/.test(r.reason ?? ""), r.reason);

console.log(`\ncontract ${w.contract}: https://testnet.nearblocks.io/address/${w.contract}`);
console.log(c.failed === 0 ? `\nAll ${c.passed} cheats refused.` : `\n${c.failed} check(s) failed.`);
process.exit(c.failed === 0 ? 0 : 1);
