// `npm run judge`: one command, free, no keys, and no Rust: about a minute on a 2-CPU Linux box from
// a fresh clone. It drives the COMMITTED contract wasm through the game's core loop and its main
// refusals in a NEAR host for Node (demo/coreloop.ts), runs the page's and the verifier's rule
// tests, builds the page, and checks the live contract on testnet. Each step prints its result the
// moment it finishes; the run ends in a pass/fail table with what each step is expected to print.
//
// NOT in the fast path, and said so in its output: the contract's Rust unit tests (property tests
// and the attack table among them), the sim's unit tests and the mutants. They need near-sdk's test
// runtime compiled first, which alone takes about three minutes on 2 CPUs. `npm run judge:full`
// runs them, with the kill test, the local-node suite and the page in a browser.
//   npm run judge        the fast path
//   npm run judge:full   also the Rust tests and the attack table (rustup), the kill test (wasmtime),
//                        the mutants, the sandbox suite on a local NEAR node (Linux: glibc 2.38+,
//                        e.g. Ubuntu 24.04) and the page in headless Chromium (10-25 more minutes)
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FULL = process.argv.includes("--full");
const root = new URL("..", import.meta.url).pathname;
// No debug info in test builds: the same tests, a faster first build on a small box.
const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/opt/rustup/bin:${process.env.PATH}`,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? `${root}target`,
  CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? "0",
  CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
  CARGO_TERM_COLOR: "never",
};
type Row = { order: number; step: string; ok: boolean | null; detail: string; expect: string; secs: number };
const rows: Row[] = [];
const spawns = (cmd: string, ...args: string[]) => !(spawnSync(cmd, args, { env, stdio: "ignore" }).error as NodeJS.ErrnoException | undefined);

function run(cmd: string, args: string[], cwd = root, extra: Record<string, string> = {}, input?: string): Promise<{ code: number; out: string; secs: number }> {
  const t0 = Date.now();
  return new Promise((ok) => {
    const c = spawn(cmd, args, { env: { ...env, ...extra }, cwd });
    c.stdin.end(input ?? "");
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", (e) => (out += String(e)));
    c.on("close", (code) => ok({ code: code ?? 1, out, secs: (Date.now() - t0) / 1000 }));
  });
}
const tally = (out: string, re: RegExp) => out.match(re)?.[0] ?? "";
/** Report a step now (as it finishes), and keep it for the table at the README's position `order`. */
function add(order: number, step: string, expect: string, r: { code: number; out: string; secs: number }, detail: string) {
  const ok = r.code === 0;
  rows.push({ order, step, ok, detail: ok ? detail : `${detail} ${r.out.split("\n").filter((l) => /✗|FAILED|panicked|error/.test(l)).slice(0, 2).join(" ").slice(0, 100)}`, expect, secs: r.secs });
  // Printed now, before anything else runs or is cleaned up.
  console.log(`${ok ? "✓" : "✗"} ${step}: ${detail} (${r.secs.toFixed(0)} s)`);
  if (!ok) console.log(r.out.split("\n").slice(-25).join("\n"));
}
const skip = (order: number, step: string, expect: string, why: string) => {
  rows.push({ order, step, ok: null, detail: why, expect, secs: 0 });
  console.log(`- ${step}: skipped, ${why}`);
};
const rustTests = (out: string) => out.match(/test result: ok\. (\d+) passed/g)?.map((x) => Number(x.match(/\d+/)![0])).reduce((a, b) => a + b, 0) ?? 0;

const E = {
  core: "All 25 core-loop checks passed.",
  contract: "48 passed",
  attack: "28 refused, 4 priced",
  sim: "6 passed",
  rules: "17 passed",
  web: "web/dist",
  verify: "All 12 checks passed.",
  kill: "PASS: 47/47 identical",
  mutants: "51/51 mutants caught",
  sandbox: "All 60 checks passed.",
  page: "All 68 page checks passed.",
};
console.log(`Ghost Duels' judge run${FULL ? " (full)" : ""}: free, no keys. It reads testnet (public RPC) and nothing else leaves this machine.`);
console.log(`Expect: ${Object.entries(E).filter(([k]) => FULL || !["contract", "attack", "sim", "kill", "mutants", "sandbox", "page"].includes(k)).map(([, v]) => v).join(" · ")}\n`);
const t0 = Date.now();

// The core loop on the committed wasm: start a run, submit inputs, the contract re-flies and pays;
// an edited score, a stranger, a key past its cap refused; the books balance. About a second.
let r = await run("npm", ["run", "--silent", "coreloop"]);
add(0, "Core loop on the committed wasm (NEAR host for Node): stake, replay, payout, refusals, the cap, the books", E.core, r, tally(r.out, /All \d+ core-loop checks passed\.|\d+ of \d+ core-loop checks failed/));
if (r.code === 0) console.log(r.out.split("\n").filter((l) => l.startsWith("✓")).map((l) => `    ${l.slice(0, 118).trimEnd()}`).join("\n"));

// The page and testnet steps, each reported the moment it resolves.
const rulesP = run("npm", ["run", "--silent", "web-rules"]).then((r) => (add(4, "Page rules (who may race what, the duel form, links, chain data) and the verifier's own rules", E.rules, r, `${tally(r.out, /pass \d+/).replace("pass ", "")} passed`), r));
const webP = rulesP.then(() => run("npm", ["run", "--silent", "build:web"])).then((r) => (add(5, "Web app builds (tsc + vite)", E.web, r, r.code === 0 ? "web/dist" : ""), r));
const verifyP = webP.then(() => run("npm", ["run", "--silent", "verify"])).then((r) => (add(6, "Testnet: v4 runs the committed wasm, no keys; ghosts replay; v1-v3 untouched", E.verify, r, tally(r.out, /All \d+ checks passed\.|\d+ check\(s\) failed/)), r));

await verifyP;

// Rust (judge:full only): the contract's unit tests, the attack table read from the same run, and
// the sim's own tests. near-sdk's test runtime compiles first: about three minutes on 2 CPUs.
const cargo = spawns("cargo", "--version");
if (FULL && cargo) {
  console.log("Rust: checking the pinned toolchain (rustup fetches 1.93.0 on first use, about half a minute)…");
  if (spawns("rustup", "--version")) console.log(`Rust: ${spawnSync("rustup", ["show", "active-toolchain"], { cwd: `${root}contracts`, env }).stdout?.toString().trim() || "installing the pinned 1.93.0 on first use"}`);
  console.log("Building and running the contract's tests: the long step (near-sdk's test dependencies compile first; 2 to 6 minutes on 2 CPUs).");
  const beat = setInterval(() => console.log(`  … still building and testing the contract (${Math.round((Date.now() - t0) / 1000)} s so far)`), 20_000);
  // --lib: the unit tests only (no doc-tests to build).
  const tests = await run("cargo", ["test", "--lib", "-p", "ghost-duels"], `${root}contracts`);
  clearInterval(beat);
  add(1, "Contract unit tests (v5 source), incl. 3 property tests", E.contract, tests, `${rustTests(tests.out)} passed`);
  // The attack suite is 31 of those tests: their names and what each asserts, from the same run.
  r = await run("npm", ["run", "--silent", "attack", "--", "--stdin"], root, {}, tests.out);
  add(2, "Attack suite: 32 attacks, each refused or priced as its test asserts", E.attack, r, tally(r.out, /\d+ refused, \d+ priced/));
  // The sim's own tests, with the contract's pinned toolchain (one toolchain to fetch, not two).
  r = await run("cargo", ["test", "-q", "--lib", "-p", "ghost-sim"], `${root}game`, { RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.93.0" });
  add(3, "Sim unit tests (the deterministic game)", E.sim, r, `${rustTests(r.out)} passed`);
} else if (FULL) {
  skip(1, "Contract unit tests, attack suite, sim tests", `${E.contract}; ${E.attack}`, "no cargo: install rustup (https://rustup.rs); the contract pins Rust 1.93");
}

if (FULL) {
  if (spawns("wasmtime", "--version")) {
    r = await run("npm", ["run", "--silent", "killtest"]);
    add(7, "Kill test: browser build = wasip2 replay job, byte for byte", E.kill, r, tally(r.out, /PASS: \d+\/\d+ identical/));
  } else skip(8, "Kill test", E.kill, "no wasmtime (curl https://wasmtime.dev/install.sh -sSf | bash)");
  if (cargo) {
    r = await run("npm", ["run", "--silent", "mutants"]);
    add(9, "Mutation checks: each security check broken, a test catches it", E.mutants, r, tally(r.out, /\d+\/\d+ mutants caught/));
    const glibc = process.platform === "linux" ? spawnSync("ldd", ["--version"]).stdout?.toString().match(/(\d+)\.(\d+)\s*$/m) : null;
    if (glibc && (Number(glibc[1]) < 2 || (Number(glibc[1]) === 2 && Number(glibc[2]) < 38))) {
      skip(10, "Sandbox suite on a local NEAR node", E.sandbox, `NEAR's sandbox binary needs glibc 2.38+ (Ubuntu 24.04); this box has ${glibc[1]}.${glibc[2]}`);
    } else {
      r = await run("npm", ["run", "--silent", "sandbox"]);
      add(11, "Sandbox suite on a local NEAR node (Linux: glibc 2.38+)", E.sandbox, r, tally(r.out, /All \d+ checks passed\.|\d+ of \d+ checks failed\.|needs wasmtime|needs glibc/));
    }
  }
  const browserOk = spawnSync("npx", ["tsx", "-e", "import('playwright').then(async (p) => { const b = await p.chromium.launch(); await b.close(); })"], { env, cwd: root }).status === 0;
  if (browserOk) {
    r = await run("npm", ["run", "--silent", "page-test"]);
    add(12, "The game in headless Chromium (desktop, phone, with and without RPC)", E.page, r, tally(r.out, /All \d+ page checks passed\.|\d+ of \d+ page checks failed/));
  } else skip(13, "The game in headless Chromium", E.page, "no Chromium: npx playwright install --with-deps chromium-headless-shell");
} else {
  const ev = (f: string, re: RegExp) => {
    try {
      return tally(readFileSync(`${root}docs/evidence/${f}`, "utf8"), re) || "(see the file)";
    } catch {
      return "(not recorded yet)";
    }
  };
  // The last recorded runs of this branch (macOS; docs/evidence/): each suite by its own command
  // on this build, except the local-node sandbox, last run on the v5 build before 0024.
  const FULL_RUN = "v5-0024-mac.txt";
  const BEFORE_0024 = "judge-full-mac-v5.txt";
  console.log(`\nNOT run here. npm run judge:full runs the first seven; their last recorded results (docs/evidence/${FULL_RUN}):`);
  console.log(`  cargo test (the contract's unit tests, incl. the property tests)  ${ev(FULL_RUN, /ghost-duels\)\n(?:test [^\n]*\n)*test result: ok\. \d+ passed/).replace(/^[^]*ok\. /, "")} (Rust; near-sdk's test runtime takes about 3 minutes to build on 2 CPUs)`);
  console.log(`  npm run attack     ${ev(FULL_RUN, /\d+ refused, \d+ priced/)} (the attack table, from the same Rust run)`);
  console.log(`  cargo test (sim)   ${ev(FULL_RUN, /ghost-sim\)\ntest result: ok\. \d+ passed/).replace(/^[^]*ok\. /, "")} (Rust)`);
  console.log(`  npm run killtest   ${ev(FULL_RUN, /PASS: \d+\/\d+ identical/)} (needs wasmtime)`);
  console.log(`  npm run mutants    ${ev(FULL_RUN, /\d+\/\d+ mutants caught/)} (Rust, a few minutes)`);
  console.log(`  npm run sandbox    ${ev(BEFORE_0024, /Sandbox suite[^\n]*: All \d+ checks passed/).replace(/^.*: /, "")} on the v5 build before 0024 (${BEFORE_0024}); not rerun on this build (a local NEAR node; Linux needs glibc 2.38+)`);
  console.log(`  npm run page-test  ${ev(FULL_RUN, /All \d+ page checks passed/)} (headless Chromium)`);
  console.log(`  npm run demo       ${ev("testnet-demo-v4.txt", /All \d+ checks passed/)} (testnet, one faucet account)`);
  console.log(`  npm run cheat      ${ev("testnet-cheat-v4.txt", /All \d+ cheats refused/)} (testnet, one faucet account)`);
  console.log(`  npm run bot        a bot that sees only the screen: median ${ev("bot/plan-1.0s.txt", /median \d+/).replace("median ", "")}; the human model: ${ev("bot/human.txt", /median \d+/).replace("median ", "")}`);
}

const w = Math.max(...rows.map((x) => x.step.length));
console.log(`\n${"-".repeat(w + 62)}`);
console.log(`${"".padEnd(6)}${"step".padEnd(w)}  ${"got".padEnd(26)}expected`);
for (const x of rows.sort((a, b) => a.order - b.order)) console.log(`${x.ok === null ? "SKIP" : x.ok ? "PASS" : "FAIL"}  ${x.step.padEnd(w)}  ${x.detail.slice(0, 25).padEnd(26)}${x.expect}`);
console.log("-".repeat(w + 62));
const failed = rows.filter((x) => x.ok === false).length;
console.log(`${rows.filter((x) => x.ok).length} passed, ${failed} failed, ${rows.filter((x) => x.ok === null).length} skipped, in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
