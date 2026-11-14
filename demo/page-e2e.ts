// `npm run page-e2e`: a visitor's real-money flow on NEAR testnet v4, in a headless browser, through
// the page's own buttons, against alice (the demo's scripted player, from the CLI):
//   1. the visitor presses "Play for real": the browser makes its key pair and a guest account, adds
//      its game key, deposits and caps it;
//   2. alice flies a private duel naming the guest; the guest opens the invite link and races it for
//      real (stake locked, the contract replays the flight and pays);
//   3. the guest flies a duel naming alice from the page; alice races it and falls short: the guest
//      earns 70% of her stake;
//   4. the guest's ghost side: names challengers, tries to retire inside the day's lock, gives the
//      ghost to alice; then races the public ladder from the list (no money moves);
//   5. the guest cashes out back to the funder, whatever happened before.
// The page's pilot is the scripted human model (demo/src/human.ts); alice is the autopilot.
//
// One stand-in, stated: the page asks NEAR's public testnet faucet to create the guest account. This
// run answers that request itself, by creating the same account for the same public key from the
// repo's funder (testnet's `create_account`, 0.5 NEAR), because the faucet allows only a few accounts
// a day per address and this repo draws once. The key pair is made in the browser and never leaves
// it; every transaction after that is the page's own. Needs web/dist, Playwright's Chromium, and the
// keys of v4's funder and of alice in the keyring.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { actions } from "near-api-js";
import { chromium, type Page } from "playwright";
import { Sim } from "../web/src/sim.ts";
import { flyHumanModelInPage } from "./src/human.ts";
import { balance, call, exists, keyed, near, sendActions, txLink, view } from "./src/near.ts";
import { Checks, fly, SHARED_CONTRACT, SHARED_FUNDER as V4_FUNDER, type Run, type World } from "./src/world.ts";

const root = new URL("../web/dist/", import.meta.url).pathname;
if (!existsSync(join(root, "index.html"))) throw new Error("web/dist is missing: npm run build:web");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]));
  const f = existsSync(p) && !p.endsWith("/") ? p : join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(f)] ?? "application/octet-stream");
  res.end(readFileSync(f));
}).listen(0);
await new Promise((ok) => server.once("listening", ok));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const C = SHARED_CONTRACT;
// Small amounts: the funder is one faucet draw.
const GUEST_NEAR = 48n * 10n ** 22n; // 0.48 NEAR for the guest account (it deposits what it can spare above 0.35)
const POT = 5n * 10n ** 22n; // 0.05 NEAR pots
const STAKE = 10n ** 22n; // 0.01 NEAR stakes
const SEVENTY = (STAKE * 70n) / 100n;
const funder = keyed(V4_FUNDER);
const alice = keyed(`alice.${V4_FUNDER}`);
const w = { sim: await Sim.load(readFileSync(new URL("../res/ghost_sim_web.wasm", import.meta.url))) } as World;
const c = new Checks();
const f0 = await balance(funder.id);
console.log(`funder ${funder.id}: ${near(f0)}; alice ${alice.id}; contract ${C}\n`);
const bal = async (id: string) => BigInt(await view<string>(C, "get_balance", { account_id: id }));
const signed = (d: bigint) => (d < 0n ? `−${near(-d)}` : `+${near(d)}`);
/** Browser dialogs the page opened (prompt, confirm, alert). The page asks in the page: none. */
let dialogs = 0;
/** Fill the page's own one-field form (web/src/main.ts `inlineForm`) under `host` and submit it. */
async function answer(p: Page, host: string, value: string) {
  const f = p.locator(`${host} form.inline`);
  await f.locator("input").fill(value);
  await f.locator('button[type="submit"]').click();
}
const browser = await chromium.launch();
// SHOTS=<dir>: also save screenshots of the real-money states (docs/screenshots/after), at 1440x900.
const SHOTS = process.env.SHOTS ? join(process.env.INIT_CWD ?? process.cwd(), process.env.SHOTS) : null;
const ctx = await browser.newContext({ viewport: SHOTS ? { width: 1440, height: 900 } : { width: 1280, height: 800 } });
const shot = async (p: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(SHOTS, `${name}.png`) });
};
await ctx.route("https://helper.nearprotocol.com/account", async (route) => {
  const { newAccountId, newAccountPublicKey } = route.request().postDataJSON() as { newAccountId: string; newAccountPublicKey: string };
  const tx = await sendActions(funder, "testnet", [actions.functionCall("create_account", { new_account_id: newAccountId, new_public_key: newAccountPublicKey }, 30n * 10n ** 12n, GUEST_NEAR)]);
  console.log(`  (faucet stand-in: ${funder.id} created ${newAccountId} with ${near(GUEST_NEAR)} for the browser's public key: ${txLink(tx)})`);
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});
async function open(at = url): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [page error] ${e}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`  [console] ${m.text().slice(0, 200)}`));
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  await page.goto(at);
  return page;
}
const overlay = (p: Page, re: RegExp, ms = 120_000) => p.locator("#overlay", { hasText: re }).innerText({ timeout: ms }).then((t) => t.replace(/\s+/g, " "));
const statusLine = (p: Page, re: RegExp) => p.locator("#you-status", { hasText: re }).innerText({ timeout: 120_000 }).catch(async () => `(timed out) ${await p.locator("#you-status").innerText()}`);
const inMode = (p: Page, m: string) => p.waitForFunction((m) => (globalThis as unknown as { __gd: () => { mode: string } | null }).__gd()?.mode === m, m, { timeout: 60_000 });

/** alice (CLI, full-access key with 1 yoctoNEAR) flies a qualifier; "ok" autopilot. */
async function aliceQualifies(qualify: Record<string, unknown>): Promise<Run> {
  const s = await call(alice, C, "start_run", { qualify }, 1n, 50n);
  if (!s.ok) throw new Error(`alice's start_run: ${s.reason}`);
  const run = s.value as Run;
  const f = fly(w, run.seed, "ok");
  const r = await call(alice, C, "submit_run", { run_id: run.id, log: f.log, claimed_score: f.score }, 0n, 100n);
  if (!r.ok) throw new Error(`alice's submit_run: ${r.reason}`);
  return r.value as Run;
}

let page: Page | null = null;
let guest = "";
try {
  console.log("1. a visitor presses Play for real");
  page = await open();
  await page.locator("#you button", { hasText: "Play for real" }).click();
  await page.locator("#you", { hasText: "Playing as" }).waitFor({ timeout: 120_000 }).catch(async () => {
    throw new Error(`never got to "Playing as": ${await page!.locator("#you-status").innerText()}`);
  });
  guest = (await page.locator("#you b").first().innerText()).trim();
  await shot(page, "desktop-7-playing-for-real");
  const keys = await (await import("./src/near.ts")).provider.viewAccessKeyList({ accountId: guest });
  const fc = keys.keys.filter((k) => typeof k.access_key.permission !== "string");
  c.check(`the browser made guest ${guest}, with a game key limited to the game's methods, and deposited`, fc.length === 1 && (await bal(guest)) > 0n, `in-game ${near(await bal(guest))}; keys: ${keys.keys.length} (${fc.length} function-call)`);

  console.log("\n2. alice flies a private duel naming the guest; the guest races it from the invite link");
  let duel = 0;
  for (let i = 0; i < 3 && !duel; i++) {
    const r = await aliceQualifies({ pot: POT.toString(), stake: STAKE.toString(), challengers: [guest] });
    console.log(`  alice: ${r.note}`);
    duel = r.minted ?? 0;
  }
  if (!duel) throw new Error("alice didn't mint a ghost in 3 tries");
  const paid = async () => BigInt((await view<{ paid: string }>(C, "get_storage")).paid);
  const [a0, g0, p0] = [await bal(alice.id), await bal(guest), await paid()];
  await page.close();
  page = await open(`${url}#duel=${duel}`);
  const inv = await overlay(page, /You're invited/, 60_000);
  c.check(`the invite link opens "You're invited" to ghost #${duel}`, /You're invited/.test(inv), inv.slice(0, 110));
  await shot(page, "desktop-8-invited");
  await page.locator("#overlay button", { hasText: `Race ghost #${duel}` }).click();
  await inMode(page, "race");
  await flyHumanModelInPage(page, 5);
  const settled = await overlay(page, /Paid out: (Won|Lost|Refused)|refused/);
  await shot(page, "desktop-9-paid-out");
  const [a1, g1, p1] = [await bal(alice.id), await bal(guest), await paid()];
  const won = /Paid out: Won/.test(settled);
  console.log(`  ${settled.slice(0, 240)}`);
  c.check(`the contract replayed the guest's flight and settled it: ${won ? "Won" : "Lost"}, with the transaction`, /Paid out: (Won|Lost)/.test(settled) && /see the transaction/.test(settled) && /on-chain: this contract replayed the log/.test(settled), "");
  // A winner's balance moves by the pot minus the storage their run's record takes (the contract
  // charges every byte to whoever adds it, 0011; `get_storage().paid` is what players have paid, and
  // only this run was settled between the two reads). The first version of this check asked for
  // "more than 90% of the pot", which a 0.05 NEAR pot fails by design: a run's record costs about
  // 0.006 NEAR whatever the pot is. The amount is now checked exactly instead.
  const storage = p1 - p0;
  c.check(won ? `the guest took the ${near(POT)} pot and the stake back, less its run's own storage, to the yocto` : `alice earned 70% of the guest's ${near(STAKE)} stake`, won ? g1 - g0 === POT - storage && storage > 0n && storage < 2n * 10n ** 22n : a1 - a0 === SEVENTY, `alice ${signed(a1 - a0)}, guest ${signed(g1 - g0)} = ${won ? `${near(POT)} − ${near(storage)} storage` : "its stake, kept"}`);

  console.log("\n3. the guest flies a duel naming alice; alice races it and falls short");
  let mine = 0;
  for (let i = 0; i < 3 && !mine; i++) {
    await page.locator("#you button", { hasText: "Fly for a ghost" }).click();
    await page.locator('input[name="kind"][value="duel"]').check();
    await page.locator("#f-names").fill(alice.id);
    await page.locator("#f-pot").fill("0.05");
    await page.locator("#f-stake").fill("0.01");
    await page.locator("#overlay button", { hasText: "Fly" }).first().click();
    await inMode(page, "qualify");
    await flyHumanModelInPage(page, 11 + i);
    const t = await overlay(page, /GHOST #\d+|NO GHOST|refused/);
    console.log(`  try ${i + 1}: ${t.slice(0, 150)}`);
    mine = Number(t.match(/GHOST #(\d+)/)?.[1] ?? 0);
    if (mine) await shot(page, "desktop-10-duel-minted");
  }
  const gm = await view<{ owner: string; challengers: string[] }>(C, "get_ghost", { ghost_id: mine });
  c.check(`the guest's duel qualifier minted ghost #${mine}, naming only alice (signed with its full-access key)`, mine > 0 && gm.owner === guest && gm.challengers.join() === alice.id, "");
  const g2 = await bal(guest);
  const s = await call(alice, C, "start_run", { ghost_id: mine }, 1n, 50n);
  const ar = s.value as Run;
  const af = fly(w, ar.seed, "weak");
  const sub = await call(alice, C, "submit_run", { run_id: ar.id, log: af.log, claimed_score: af.score }, 0n, 100n);
  const g3 = await bal(guest);
  c.check(`alice (named) races it and falls short: the guest earns 70% of her ${near(STAKE)}`, s.ok && (sub.value as Run)?.status === "Lost" && g3 - g2 === SEVENTY, `${(sub.value as Run)?.note}; guest +${near(g3 - g2)}`);

  console.log("\n4. the guest's ghost side, then the public ladder");
  await page.close();
  page = await open();
  await page.locator(".ghosts li", { hasText: `#${mine} ` }).first().waitFor({ timeout: 60_000 });
  await page.locator(".ghosts li", { hasText: `#${mine} ` }).locator("button", { hasText: "Challengers…" }).click();
  await answer(page, `.ghosts li[data-id="${mine}"]`, `${alice.id}, bob.${V4_FUNDER}`);
  const st1 = await statusLine(page, /Naming 2 challengers.*(done|refused)/);
  const gc = await view<{ challengers: string[] }>(C, "get_ghost", { ghost_id: mine });
  c.check("Challengers… names alice and bob (full-access key, 1 yoctoNEAR)", gc.challengers.length === 2, `${gc.challengers.join(", ")} · ${st1.slice(0, 60)}`);
  await page.locator(".ghosts li", { hasText: `#${mine} ` }).locator("button", { hasText: "Retire" }).click();
  const st2 = await statusLine(page, /Retiring.*(done|refused)/);
  c.check("Retire reaches the contract, which keeps a new ghost's pot locked for a day", /locked until/.test(st2), st2.slice(0, 120));
  await page.locator(".ghosts li", { hasText: `#${mine} ` }).locator("button", { hasText: "Give…" }).click();
  await answer(page, `.ghosts li[data-id="${mine}"]`, alice.id);
  await statusLine(page, /Giving ghost.*(done|refused)/);
  const tok = await view<{ owner_id: string }>(C, "nft_token", { token_id: String(mine) });
  c.check(`Give… hands ghost #${mine} (NEP-171) to alice`, tok.owner_id === alice.id, tok.owner_id);
  const ladder = (await view<{ id: number; stake: string; owner: string }[]>(C, "get_ghosts", { limit: 100 })).find((g) => g.stake === "0" && g.owner !== guest);
  if (!ladder) throw new Error("no public-ladder ghost to race");
  const owner0 = await bal(ladder.owner);
  await page.locator(".ghosts li", { hasText: `#${ladder.id} ` }).locator("button", { hasText: "Race (on chain, free)" }).click();
  await inMode(page, "race");
  await flyHumanModelInPage(page, 9);
  const lt = await overlay(page, /Paid out: (Won|Lost|Refused)|refused/);
  c.check(`the guest races public-ladder ghost #${ladder.id} from the list: recorded, and no money moves`, /no money moves/.test(lt) && (await bal(ladder.owner)) === owner0, lt.match(/Paid out: \w+/)?.[0] ?? lt.slice(0, 80));
} catch (e) {
  c.check("the flow ran to the end", false, String((e as Error).message ?? e).slice(0, 220));
} finally {
  // Whatever happened: the guest cashes out to the funder, so no testnet NEAR is left in a browser.
  if (guest && (await exists(guest))) {
    console.log("\n5. the guest cashes out back to the funder");
    try {
      if (page) await page.close();
      page = await open();
      await page.locator("#you button", { hasText: "Cash out…" }).click();
      await answer(page, "#you", V4_FUNDER);
      const st = await statusLine(page, /is closed|failed/);
      c.check("Cash out… withdraws, closes the guest and sends everything to the funder", !(await exists(guest)) && /is closed/.test(st), `${st.slice(0, 70)} · funder ${near(f0)} → ${near(await balance(funder.id))}`);
    } catch (e) {
      c.check("the guest cashed out", false, String(e).slice(0, 160));
    }
  }
}
c.check("the page asked for every answer in the page: no browser prompt or dialog opened", dialogs === 0, `${dialogs} dialogs`);
// The result first, then the cleanup.
console.log(c.failed === 0 ? `\nAll ${c.passed} checks passed.` : `\n${c.failed} check(s) failed.`);
await browser.close();
server.close();
process.exit(c.failed === 0 ? 0 : 1);
