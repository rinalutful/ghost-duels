// KILL TEST: the same input log must give a byte-identical final state and score in the browser build
// (res/ghost_sim_web.wasm, run here in Node) and in the replay job (res/ghost_replay_job.wasm, a
// wasm32-wasip2 binary run under wasmtime, as OutLayer's TEE workers or our runner run it).
//
// Logs come from live play: an autopilot flies each seed through the browser build tick by tick (the
// way the page does), and the wasm records the button changes. Then each log is replayed both ways.
// Writes docs/evidence/killtest.txt. Exit 1 on any mismatch.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { autopilot, logBytes, Sim } from "../web/src/sim.ts";
import { runJob, wasmtimeVersion } from "./src/replay.ts";

const res = (f: string) => readFileSync(new URL(`../res/${f}`, import.meta.url));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const sim = await Sim.load(res("ghost_sim_web.wasm"));
const N = Number(process.env.CASES ?? 40);

// A tiny seeded PRNG for the autopilot's "human" error, so the test is itself reproducible.
function mulberry(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Case = { name: string; seed: Uint8Array; log: number[]; live?: { score: number; state: string } };
const cases: Case[] = [];
for (let i = 0; i < N; i++) {
  const seed = createHash("sha256").update(`ghost-duels kill test ${i}`).digest();
  const rnd = mulberry(i + 1);
  const score = autopilot(sim, 0, seed, 16 + (i % 5) * 8, 4 + (i % 4) * 2, rnd, (i % 7) * 6);
  cases.push({ name: `live-${i}`, seed, log: sim.log(0), live: { score, state: sha(sim.state(0)) } });
}
const s0 = createHash("sha256").update("edge").digest();
cases.push({ name: "empty-log", seed: s0, log: [] });
cases.push({ name: "hold-forever", seed: s0, log: [0] });
cases.push({ name: "last-tick", seed: s0, log: [3599] });
cases.push({ name: "toggles-after-crash", seed: s0, log: [5, 6, 7, 3000, 3001] });

const lines: string[] = [];
let bad = 0;
for (const c of cases) {
  const browserScore = sim.replay(1, c.seed, c.log);
  const browserState = sha(sim.state(1));
  const browserLog = sha(logBytes(c.log));
  const job = runJob({ seed: Buffer.from(c.seed).toString("hex"), log: c.log });
  const same = job.score === browserScore && job.final_state_hash === browserState && job.log_hash === browserLog
    && (!c.live || (c.live.score === browserScore && c.live.state === browserState));
  if (!same) bad++;
  lines.push(`${same ? "MATCH" : "DIFF "} ${c.name.padEnd(20)} toggles=${String(c.log.length).padStart(4)} ticks=${String(job.ticks).padStart(4)} score=${String(browserScore).padStart(5)}/${String(job.score).padStart(5)} state=${browserState.slice(0, 16)}/${String(job.final_state_hash).slice(0, 16)}`);
}
// Refusals must agree too.
const badLogs: [string, number[]][] = [["not-increasing", [5, 5]], ["past-end", [3600]], ["too-long", Array.from({ length: 2049 }, (_, i) => i)]];
for (const [name, log] of badLogs) {
  const b = sim.replay(1, s0, log);
  const j = runJob({ seed: Buffer.from(s0).toString("hex"), log });
  const same = b === -1 && typeof j.error === "string";
  if (!same) bad++;
  lines.push(`${same ? "MATCH" : "DIFF "} refuse-${name.padEnd(13)} browser=${b} job=${JSON.stringify(j.error)}`);
}

const header = [
  `Kill test: browser build (Node ${process.version}) vs wasm32-wasip2 replay job (${wasmtimeVersion()})`,
  `res/ghost_sim_web.wasm   sha256 ${sha(res("ghost_sim_web.wasm"))}`,
  `res/ghost_replay_job.wasm sha256 ${sha(res("ghost_replay_job.wasm"))}`,
  `${cases.length} logs (${N} from live play) + ${badLogs.length} refusals; each line: browser/job`,
  "",
];
const body = lines.join("\n");
const footer = `\n\n${bad === 0 ? "PASS" : "FAIL"}: ${cases.length + badLogs.length - bad}/${cases.length + badLogs.length} identical. Digest of all results: ${sha(body)}\n`;
mkdirSync(new URL("../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(new URL("../docs/evidence/killtest.txt", import.meta.url), header.join("\n") + body + footer);
console.log(header.join("\n") + body + footer);
process.exit(bad === 0 ? 0 : 1);
