// `npm run verify`: re-reads testnet (free, no keys) and checks the deploys the README names.
//   - v4 (the live one) runs exactly res/ghost_duels.wasm, this source's build (its code hash against
//     the file and res/v4/SHA256SUMS), on-chain only, with the bounded parameters the README states,
//     and its account has NO access keys: nobody can redeploy it or move its NEAR;
//   - its ghosts: each stored log hashes to its log_hash and replays (in the browser build, here in
//     Node) to its recorded score; every staked ghost is a private duel with a list of at most 16
//     challengers (an empty list is a duel its owner closed), every public-ladder ghost holds no
//     money; every kept stake was split as the contract rounds it (5% rake, 25% pot, the rest);
//     these hold whatever players do to v4 (demo/src/verify-rules.ts, demo/verify-rules.test.ts);
//   - v3, v2 and v1 are still there, untouched (their own code hashes; v3 with no keys).
// It also prints who has played v4 (accounts, settled races, pots paid), as a count, not a check.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { baseEncode } from "near-api-js";
import { Sim, logBytes } from "../web/src/sim.ts";
import { provider, view } from "./src/near.ts";
import { duelListOk, isStaked, ladderOk, replaySample, splitOk, type GhostRecord } from "./src/verify-rules.ts";
import { Checks, DEPLOY, SHARED_CONTRACT, SHARED_FUNDER as V4_FUNDER, V3_CONTRACT } from "./src/world.ts";

const V1 = "duels.ghost-duels-jbx5v9.testnet";
const V1_CODE = "FZsbVZTyYSGLxxGbaTkKSZ1u8iPmidvvgbyB6kandw45";
const V2 = "v2.ghost-duels-jbx5v9.testnet";
const V2_CODE = "ERBJdAZs1PBCbPmgkVxWf7T6aEfCPhfS9AX8CAWaKPE";
const c = new Checks();
const res = (f: string) => readFileSync(new URL(`../res/${f}`, import.meta.url));
const bs58 = (b: Buffer) => baseEncode(createHash("sha256").update(b).digest());
const hexsum = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const V4 = SHARED_CONTRACT;

// The live deploy runs the build res/deploy.json names. While this source's own build
// (res/ghost_duels.wasm) isn't deployed, that is the previous version's, and the first line says so.
const live = DEPLOY.wasm === "ghost_duels.wasm";
const wasm = res(DEPLOY.wasm);
const acct = await provider.viewAccount({ accountId: V4 });
const sums = res(DEPLOY.wasm.replace(/[^/]+$/, "SHA256SUMS")).toString();
const pinned = sums.split("\n").find((l) => l.trim().endsWith("ghost_duels.wasm"))?.split(/\s+/)[0];
if (!live) console.log(`The live contract is ${DEPLOY.version}. This source is ${DEPLOY.source}: built (res/ghost_duels.wasm), tested, and not deployed; the checks below are of ${DEPLOY.version}.\n`);
c.check(`${V4} runs res/${DEPLOY.wasm}, the committed build of ${live ? "this source" : DEPLOY.version + "'s source"}`, acct.code_hash === bs58(wasm) && hexsum(wasm) === pinned, acct.code_hash);
const cfg = await view<Record<string, unknown>>(V4, "get_config");
c.check("…on-chain only (no runner, no OutLayer can be set), no replay fee, owned by its funder", cfg.mode === "OnChain" && cfg.offchain_allowed === false && cfg.replay_fee === "0" && cfg.owner === V4_FUNDER, `mode ${cfg.mode}, offchain_allowed ${cfg.offchain_allowed}, fee ${cfg.replay_fee}, owner ${cfg.owner}`);
const keys = await provider.viewAccessKeyList({ accountId: V4 });
c.check("…and its account has no access keys (no redeploy, no withdrawal by anyone)", keys.keys.length === 0, `${keys.keys.length} keys`);
c.check("…rake 5%, pot share 25%, abandon fee 20%, 90 s runs, a day's pot lock, 100 points to mint", cfg.rake_bps === 500 && cfg.pot_bps === 2500 && cfg.abandon_bps === 2000 && cfg.run_secs === 90 && cfg.pot_lock_secs === 86400 && cfg.min_ghost_score === 100, JSON.stringify({ rake: cfg.rake_bps, pot: cfg.pot_bps, abandon: cfg.abandon_bps, run: cfg.run_secs, lock: cfg.pot_lock_secs, min: cfg.min_ghost_score }));

type G = GhostRecord & { score: number; seed: string; log_hash: string };
// Every ghost, a page at a time (the records are small; the logs are fetched for a bounded sample).
const ghosts: G[] = [];
for (let from = 0; ; from += 100) {
  const page = await view<G[]>(V4, "get_ghosts", { from_index: from, limit: 100 });
  ghosts.push(...page);
  if (page.length < 100) break;
}
const sim = await Sim.load(res("ghost_sim_web.wasm"));
const sample = replaySample(ghosts);
let replayed = 0;
for (const g of sample) {
  const l = await view<{ seed: string; log: number[] }>(V4, "get_ghost_log", { ghost_id: g.id });
  const h = createHash("sha256").update(logBytes(l.log)).digest("hex");
  const score = sim.replay(0, Uint8Array.from(Buffer.from(l.seed, "hex")), l.log);
  if (h === g.log_hash && score === g.score) replayed++;
}
c.check(sample.length === ghosts.length ? `all ${ghosts.length} ghosts' logs hash to their log_hash and replay to their score` : `${sample.length} of ${ghosts.length} ghosts (the 20 oldest, the 20 newest): logs hash to their log_hash and replay to their score`, ghosts.length > 0 && replayed === sample.length, `${replayed}/${sample.length}`);
// These three hold in every state a player can put v4 in (demo/src/verify-rules.ts says why):
// anyone can play a contract nobody can change, so a check a guest could fail would fail for all.
const staked = ghosts.filter(isStaked);
const ladder = ghosts.filter((g) => !isStaked(g));
const closed = staked.filter((g) => g.challengers.length === 0);
c.check("every staked ghost is a private duel: a list of at most 16 named challengers (none: closed)", staked.every(duelListOk), `${staked.length} duels${closed.length ? `, ${closed.length} closed by their owners` : ""}: ${staked.slice(-8).map((g) => `#${g.id}: ${g.challengers.map((a) => a.split(".")[0]).join(",") || "closed"}`).join(" ")}`);
c.check("every public-ladder ghost holds no money and names no one", ladder.every(ladderOk), `${ladder.length} on the ladder: ${ladder.slice(-8).map((g) => `#${g.id} ${g.defended}d/${g.beaten}b`).join(" ")}`);
c.check("every stake a ghost kept was split 5% rake, 25% pot, the rest (70%) to its owner", staked.every(splitOk), staked.filter((g) => g.defended + g.forfeits > 0).slice(-8).map((g) => `#${g.id} kept ${g.defended + g.forfeits}`).join(" "));
const st = await view<{ paid: string; usage_bytes: number }>(V4, "get_storage");
c.check("players have paid for the storage they added", BigInt(st.paid) > 0n, `paid ${(Number(BigInt(st.paid) / 10n ** 18n) / 1e6).toFixed(4)} NEAR, ${st.usage_bytes} B in all`);

// History: untouched.
if (DEPLOY.version !== "v4") {
  const v4 = "v4.near-ghost-duels-rywu8u.testnet";
  const [a4, k4] = [await provider.viewAccount({ accountId: v4 }), await provider.viewAccessKeyList({ accountId: v4 })];
  c.check(`v4 (${v4}) still runs res/v4/ghost_duels.wasm, with no keys`, a4.code_hash === bs58(res("v4/ghost_duels.wasm")) && k4.keys.length === 0, a4.code_hash);
}
const v3 = await provider.viewAccount({ accountId: V3_CONTRACT });
const v3keys = await provider.viewAccessKeyList({ accountId: V3_CONTRACT });
c.check(`v3 (${V3_CONTRACT}) still runs res/v3/ghost_duels.wasm, with no keys`, v3.code_hash === bs58(res("v3/ghost_duels.wasm")) && v3keys.keys.length === 0, v3.code_hash);
const v1 = await provider.viewAccount({ accountId: V1 });
c.check(`v1 (${V1}) is still there, untouched`, v1.code_hash === V1_CODE, v1.code_hash);
const v2 = await provider.viewAccount({ accountId: V2 });
c.check(`v2 (${V2}) is still there, untouched`, v2.code_hash === V2_CODE, v2.code_hash);

// Who has played v4 (issue #24): accounts under its funder are the team's demo players; the others
// are guests the page made (our own page tests make them too, so this is a count, not a claim of
// outside players).
type R = { player: string; status: string; ghost: number | null; stake: string; note: string | null };
const runs: R[] = [];
// The newest 2,000 runs at most: a count for the reader, bounded however many runs players start.
for (let from: number | null = null, pages = 0; pages < 20; pages++) {
  const page = await view<(R & { id: number })[]>(V4, "get_runs", { from, limit: 100 });
  runs.push(...page);
  if (page.length < 100 || page[page.length - 1].id <= 1) break;
  from = page[page.length - 1].id - 1;
}
const players = [...new Set(runs.map((r) => r.player))];
const team = players.filter((p) => p.endsWith(`.${V4_FUNDER}`) || p === V4_FUNDER);
const duels = runs.filter((r) => r.ghost !== null && BigInt(r.stake) > 0n && (r.status === "Won" || r.status === "Lost"));
const paid = runs.filter((r) => r.status === "Won" && BigInt(r.stake) > 0n && /won its/.test(r.note ?? "")).length;
console.log(`\nplayed on v4: ${runs.length} runs by ${players.length} accounts (${team.length} the team's demo players, ${players.length - team.length} guests the page made, this repo's own page tests among them); ${duels.length} settled staked duels, ${paid} pots won; ${runs.filter((r) => r.ghost !== null && r.stake === "0").length} public-ladder races`);
console.log(c.failed === 0 ? `\nAll ${c.passed} checks passed.` : `\n${c.failed} check(s) failed.`);
process.exit(c.failed === 0 ? 0 : 1);
