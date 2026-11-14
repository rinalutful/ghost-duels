// `npm run demo`: the whole loop on NEAR testnet, free. One faucet account; under it a deploy of
// Ghost Duels v4 (on-chain only: the contract replays every run itself) and two players whose apps
// play with capped session keys. The players are an autopilot flying the browser build of the game.
//   1. alice flies a qualifier for a private duel with bob (0019): its 0.5 NEAR pot and 0.1 NEAR
//      stake are locked before the cave exists, and the replay that verifies it mints it as a ghost
//      (NFT) in the same transaction. Naming bob takes her full-access key (the one prompt a wallet
//      would show); everything after is her app's session key;
//   2. an account she didn't name is refused: staked play is between players who chose each other;
//   3. bob challenges and loses: alice earns 70% of his stake, the pot grows 25%, the house takes 5%;
//   4. bob challenges again and wins: he takes the grown pot;
//   5. the public ladder: bob's app flies a ghost with no pot and no stake, alice's app races it, and
//      no money moves;
//   6. bob flies a duel of his own, naming alice: the new champion.
// `npm run demo -- --shared` runs it on the live v4 (the funder's key in the keyring).
import { Checks, balanceOf, getGhost, near, play, world } from "./src/world.ts";
import { N, call, view } from "./src/near.ts";

const w = await world(process.argv.includes("--shared") ? "shared" : "fresh");
const c = new Checks();
const d = (a: bigint, b: bigint) => near(b - a);

console.log("1. alice flies a qualifier for a private duel with bob; it becomes a ghost");
const q = await play(w, w.alice, null, "ok", undefined, undefined, { pot: N("0.5"), stake: N("0.1"), challengers: [w.bob.id] });
const ghostId = q.run.minted ?? 0;
c.check("the contract's replay verifies it and mints it in the same transaction", q.run.status === "Minted" && ghostId > 0, `${q.run.note} · ${q.run.replay?.via}`);
const tok = await view<{ owner_id: string; metadata: { title: string } }>(w.contract, "nft_token", { token_id: String(ghostId) });
c.check(`ghost #${ghostId} is a NEP-171 token owned by alice, naming bob`, tok?.owner_id === w.alice.id && (await getGhost(w, ghostId)).challengers.join() === w.bob.id, tok?.metadata.title);

console.log("\n2. an account alice didn't name tries to race it");
const s = await call(w.funder, w.contract, "start_run", { ghost_id: ghostId }, 1n, 50n);
c.check(`${w.funder.id.split(".")[0]} is refused: a private duel`, !s.ok && /private duel/.test(s.reason ?? ""), s.reason);

console.log("\n3. bob challenges the ghost and loses");
const [a0, h0] = [await balanceOf(w, w.alice.id), await balanceOf(w, w.owner.id)];
const lost = await play(w, w.bobApp, ghostId, "weak");
const [a1, h1] = [await balanceOf(w, w.alice.id), await balanceOf(w, w.owner.id)];
const g1 = await getGhost(w, ghostId);
c.check("bob's run doesn't beat the ghost", lost.run.status === "Lost", lost.run.note ?? "");
c.check("his 0.1 stake splits: alice 0.07, the house 0.005, the pot +0.025", a1 - a0 === BigInt(N("0.07")) && h1 - h0 === BigInt(N("0.005")) && BigInt(g1.pot) === BigInt(N("0.525")), `alice +${d(a0, a1)}, house +${d(h0, h1)}, pot ${near(g1.pot)}`);

console.log("\n4. bob challenges again and wins");
const b0 = await balanceOf(w, w.bob.id);
const won = await play(w, w.bobApp, ghostId, "strong");
const b1 = await balanceOf(w, w.bob.id);
c.check("bob beats the ghost", won.run.status === "Won", won.run.note ?? "");
c.check("bob takes the 0.525 pot (less the run's storage)", b1 - b0 > BigInt(N("0.51")) && b1 - b0 < BigInt(N("0.525")), `+${d(b0, b1)}`);
const g = await getGhost(w, ghostId);
c.check(`ghost #${ghostId}'s record: defended 1, beaten 1, pot 0`, g.defended === 1 && g.beaten === 1 && g.pot === "0", `earned ${near(g.earned)}, raked ${near(g.raked)}`);
const t = await view<{ metadata: { description: string } }>(w.contract, "nft_token", { token_id: String(ghostId) });
console.log(`  as a wallet shows it: ${t.metadata.description}`);

console.log("\n5. the public ladder: no pot, no stake, anyone races, no money moves");
const pq = await play(w, w.bobApp, null, "ok", undefined, undefined, { pot: "0", stake: "0" });
c.check(`bob's app flies a public-ladder ghost, #${pq.run.minted} (a session key may: there's no money in it)`, pq.run.status === "Minted", pq.run.note ?? "");
const [pb0, ph0] = [await balanceOf(w, w.bob.id), await balanceOf(w, w.owner.id)];
const pr = await play(w, w.aliceApp, pq.run.minted!, "ok");
const [pb1, ph1] = [await balanceOf(w, w.bob.id), await balanceOf(w, w.owner.id)];
c.check("alice's app races it; the record counts and no money moves", (pr.run.status === "Won" || pr.run.status === "Lost") && pb1 === pb0 && ph1 === ph0 && /no money moves/.test(pr.run.note ?? ""), pr.run.note ?? "");

console.log("\n6. bob flies a private duel of his own, naming alice: the new champion");
const q2 = await play(w, w.bob, null, "strong", undefined, undefined, { pot: N("0.3"), stake: N("0.05"), challengers: [w.alice.id] });
c.check(`bob's qualifier becomes ghost #${q2.run.minted} (${q2.score} points)`, q2.run.status === "Minted", q2.run.note ?? "");

console.log(`\ncontract ${w.contract}: https://testnet.nearblocks.io/address/${w.contract}`);
console.log(c.failed === 0 ? `All ${c.passed} checks passed.` : `${c.failed} check(s) failed.`);
process.exit(c.failed === 0 ? 0 : 1);
