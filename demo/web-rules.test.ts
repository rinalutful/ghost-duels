// `npm run web-rules`: the web page's chain rules (web/src/rules.ts), without a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifierSpare, qualifierShortfall, canRace, cleanGhost, cleanLog, cleanRun, contractFrom, ghostKind, ghostState, inviteLink, msLeft, mustEndNow, qualifyArgs, startArgs, SUBMIT_MARGIN_MS } from "../web/src/rules.ts";

test("a duel in a race says so and keeps its button; a ladder ghost counts its racers (0015, 0023)", () => {
  assert.deepEqual(ghostState({ pot: "10", stake: "5", racing: 1 }), { open: true, label: "a race is in flight (90 s at most)" });
  assert.deepEqual(ghostState({ pot: "10", stake: "5", racing: 0 }), { open: true, label: "open" });
  assert.deepEqual(ghostState({ pot: "0", stake: "5", racing: 0 }), { open: false, label: "beaten" });
  assert.deepEqual(ghostState({ pot: "0", stake: "0", racing: 3 }), { open: true, label: "3 racing now" });
});

test("start_run always carries max_fee, at the fee the page showed (finding 7)", () => {
  assert.deepEqual(startArgs(4, { replay_fee: "0" }, "0"), { ghost_id: 4, max_fee: "0", min_pot: "0" });
  assert.equal(startArgs(4, { replay_fee: "20000000000000000000000" }, "0").max_fee, "20000000000000000000000");
});

test("start_run asks for at least the pot the page showed (a pot won and refilled smaller is not what the stake was for)", () => {
  assert.equal(startArgs(4, { replay_fee: "0" }, "500000000000000000000000").min_pot, "500000000000000000000000");
});

test("a real run ends itself before the 90 s deadline, and when the tab is hidden (finding 7)", () => {
  const run = { started_ms: 1_000_000, deadline_ms: 1_090_000 };
  assert.equal(msLeft(run, 5_000, 5_000), 90_000);
  assert.equal(mustEndNow(msLeft(run, 5_000, 5_000 + 60_000), false), false);
  assert.equal(mustEndNow(msLeft(run, 5_000, 5_000 + 90_000 - SUBMIT_MARGIN_MS), false), true);
  assert.equal(mustEndNow(80_000, true), true);
});

const g = (over: Partial<{ owner: string; pot: string; stake: string; racing: number; challengers: string[] }>) => ({ owner: "alice.testnet", pot: "200", stake: "50", racing: 0, challengers: ["bob.testnet"], ...over });

test("a duel is raced for real only by the players its owner named; the ladder by anyone but its owner (0019)", () => {
  assert.equal(ghostKind(g({})), "duel");
  assert.equal(canRace(g({}), "bob.testnet"), true);
  assert.equal(canRace(g({}), "mallory.testnet"), false, "a stranger only gets a practice race");
  assert.equal(canRace(g({}), null), false);
  assert.equal(canRace(g({}), "alice.testnet"), false, "never your own ghost");
  assert.equal(canRace(g({ pot: "0" }), "bob.testnet"), false, "a beaten duel waits for a refill");
  assert.equal(canRace(g({ pot: "40" }), "bob.testnet"), false, "a pot below its stake can't be raced");
  const ladder = g({ pot: "0", stake: "0", challengers: [] });
  assert.equal(ghostKind(ladder), "ladder");
  assert.deepEqual(ghostState(ladder), { open: true, label: "public ladder" });
  assert.equal(canRace(ladder, "mallory.testnet"), true);
  assert.equal(canRace(ladder, "alice.testnet"), false);
});

test("flying for a ghost: the ladder stakes nothing; a duel names 1-16 others, pot ≥ stake, signed with the full-access key", () => {
  const y = (n: string) => String(Math.round(Number(n) * 1000)) + "0".repeat(21);
  assert.deepEqual(qualifyArgs("ladder", "me.testnet", "9", "9", "x.testnet", { replay_fee: "0" }, y), { args: { qualify: { pot: "0", stake: "0" }, max_fee: "0" }, deposit: 0n });
  const d = qualifyArgs("duel", "me.testnet", "0.2", "0.05", " Bob.testnet, carol.testnet bob.testnet ", { replay_fee: "0" }, y);
  assert.equal(d.deposit, 1n, "naming who may race your money takes the full-access key");
  assert.deepEqual(d.args.qualify, { pot: y("0.2"), stake: y("0.05"), challengers: ["bob.testnet", "carol.testnet"] });
  assert.throws(() => qualifyArgs("duel", "me.testnet", "0.2", "0.05", "", { replay_fee: "0" }, y), /name 1 to 16/);
  assert.throws(() => qualifyArgs("duel", "me.testnet", "0.2", "0.05", "me.testnet", { replay_fee: "0" }, y), /your own ghost/);
  assert.throws(() => qualifyArgs("duel", "me.testnet", "0.01", "0.05", "bob.testnet", { replay_fee: "0" }, y), /at least as big as the stake/);
  assert.throws(() => qualifyArgs("duel", "me.testnet", "0.2", "0.05", "not an account!", { replay_fee: "0" }, y), /isn't a NEAR account id/);
});

test("the invite link carries the ghost, and the contract only when it isn't the default", () => {
  assert.equal(inviteLink("https://x.dev/gd/#duel=3", "v4.a.testnet", 7, "v4.a.testnet"), "https://x.dev/gd/#duel=7");
  assert.equal(inviteLink("https://x.dev/gd/", "other.testnet", 7, "v4.a.testnet"), "https://x.dev/gd/#duel=7&contract=other.testnet");
});

test("a link can't point the page at something that isn't an account id", () => {
  const v4 = "v4.near-ghost-duels-rywu8u.testnet";
  assert.equal(contractFrom(null, v4), v4);
  assert.equal(contractFrom("v5.example.testnet", v4), "v5.example.testnet");
  assert.equal(contractFrom('"><img src=x onerror=alert(1)>', v4), v4);
  assert.equal(contractFrom("UPPER.testnet", v4), v4);
});

test("what a contract answers is coerced before it is drawn: markup never survives as a number, an amount or an account", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const g = cleanGhost({ id: 3, owner: evil, pilot: "bob.testnet", score: evil, pot: evil, stake: "50", challengers: [evil, "carol.testnet"], seed: evil, racing: "2", defended: -1 });
  assert.deepEqual([g.owner, g.score, g.pot, g.stake, g.seed, g.racing, g.defended], ["invalid-account", 0, "0", "50", "", 2, 0]);
  assert.deepEqual(g.challengers, ["invalid-account", "carol.testnet"]);
  assert.equal(JSON.stringify(g).includes("<"), false);
  const r = cleanRun({ id: 9, status: evil, note: evil, minted: evil, replay: { score: evil, via: "on-chain" } });
  assert.deepEqual([r.status, r.minted, r.replay?.score], ["Unknown", 0, 0]);
  assert.equal(r.note, evil, "free text is kept, and escaped where it is shown");
  assert.deepEqual(cleanLog({ seed: "ab".repeat(32), log: [3, "9", evil, 4000] }), { seed: "ab".repeat(32), log: [3, 9, 0] });
  assert.equal(cleanGhost(null).id, 0);
});

test("the page won't start a qualifier its balance can't finish (v4 takes the recording's storage at submit; v5 holds it from the start)", () => {
  const N = 10n ** 24n;
  const fmt = (y: bigint) => (Number(y / 10n ** 21n) / 1000).toFixed(3);
  assert.equal(qualifierSpare("v4"), 60_640n * 10n ** 18n, "v4: about 0.061 NEAR kept back by the page");
  assert.equal(qualifierSpare("v5"), 112_560n * 10n ** 18n, "v5: the contract's own hold, 2,000 + 8,256 bytes, and the run's record");
  // 0.064 NEAR in the game and a 0.05 pot: about what a demo player had on v4 when its good run
  // could not be submitted (the contract wanted 0.026 for the recording and found 0.014).
  assert.match(qualifierShortfall((N * 64n) / 1000n, N / 20n, fmt)!, /A 0\.050 pot needs 0\.110/);
  assert.equal(qualifierShortfall((N * 111n) / 1000n, N / 20n, fmt), null);
  assert.match(qualifierShortfall(N / 20n, 0n, fmt)!, /A ghost needs 0\.060/);
  assert.equal(qualifierShortfall(N / 10n, 0n, fmt), null);
  assert.match(qualifierShortfall((N * 111n) / 1000n, N / 20n, fmt, "v5")!, /A 0\.050 pot needs 0\.162/);
  assert.equal(qualifierShortfall((N * 163n) / 1000n, N / 20n, fmt, "v5"), null);
});
