// `npm run page-test`: the built web app (web/dist) in a headless browser. It fails on any console
// error, on a black canvas, or if a run doesn't advance. The testnet RPC is blocked in the first two
// passes, so the game must play with no network; the third lets it through and checks the ghost list;
// the last plays for real against a mocked chain (demo/src/mockchain.ts), with nothing sent anywhere.
// Needs Playwright's Chromium (`npx playwright install chromium-headless-shell` once).
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { KeyPair } from "near-api-js";
import { chromium, type Page, type Route } from "playwright";
import { flyLikeAHuman, gdState } from "./src/human.ts";
import { ghost, MockChain } from "./src/mockchain.ts";

const live = JSON.parse(readFileSync(new URL("../res/deploy.json", import.meta.url), "utf8")) as { version: string; contract: string };

const root = new URL("../web/dist/", import.meta.url).pathname;
if (!existsSync(join(root, "index.html"))) throw new Error("web/dist is missing: npm run build:web");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png" };
const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]));
  const f = existsSync(p) && !p.endsWith("/") ? p : join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(f)] ?? "application/octet-stream");
  res.end(readFileSync(f));
}).listen(0);
await new Promise((ok) => server.once("listening", ok));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

let bad = 0;
let n = 0;
const check = (name: string, ok: boolean, detail = "") => {
  n++;
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(66)} ${detail}`);
};


type Sound = { muted: boolean; context: string; played: number };
const sound = (page: Page) => page.evaluate(() => (globalThis as unknown as { __gdSound: () => Sound }).__gdSound());

/** Share of the canvas that is pure black, and how many distinct colours it has (sampled). */
const canvasStats = (page: Page) =>
  page.evaluate(() => {
    const c = document.getElementById("game") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let black = 0;
    const colours = new Set<number>();
    let total = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      total++;
      if (d[i] + d[i + 1] + d[i + 2] === 0) black++;
      colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return { black: black / total, colours: colours.size };
  });

const gd = (page: Page) => page.evaluate(() => (globalThis as unknown as { __gd: () => { mode: string; playing: boolean; countdown: number; done: boolean } | null }).__gd());
const text = async (page: Page, sel: string) => (await page.locator(sel).innerText()).replace(/\s+/g, " ");
/** Wait until `ok()` holds (or `ms` pass): a slow machine gets the time it needs, a fast one none. */
const poll = async (ok: () => Promise<boolean> | boolean, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms && !(await ok()); ) await new Promise((r) => setTimeout(r, 50));
};
const tap = (l: ReturnType<Page["locator"]>) => l.click({ timeout: 2000 }).catch(() => {});
const until = (page: Page, sel: string, re: RegExp, ms = 15_000) => page.locator(sel, { hasText: re }).first().waitFor({ timeout: ms }).then(() => true, () => false);

/** The real-play states, against a stand-in for testnet (demo/src/mockchain.ts): a guest this
 *  browser holds, real races and qualifiers with their transactions held pending, invites, the
 *  owner's buttons, an empty board, and a faucet that says no. No request leaves this machine. */
async function mockedChain() {
  console.log("\ndesktop, a mocked chain: a guest in this browser, transactions held pending (no request leaves this machine)");
  const ME = "gd-mock0test.testnet";
  const chain = new MockChain();
  const reset = () =>
    (chain.ghosts = [
      ghost(1, { challengers: [ME] }),
      ghost(2, { pot: "0", stake: "0", qualified_pot: "0", score: 120 }),
      ghost(3, { owner: ME, challengers: ["bob.testnet"], score: 130 }),
      ghost(4, { pot: "0", challengers: [ME], beaten: 1, score: 140 }),
      ghost(5, { owner: "carol.testnet", challengers: ["dave.testnet"], score: 300 }),
    ]);
  reset();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const store = `ghost-duels-guest:${live.contract}`;
  // Throwaway keys for an account that exists only in the mock: made here, never shown or saved.
  const guest = JSON.stringify({ id: ME, full: KeyPair.fromRandom("ed25519").toString(), session: KeyPair.fromRandom("ed25519").toString() });
  await ctx.addInitScript(([k, v]) => {
    if (!sessionStorage.getItem("no-guest")) localStorage.setItem(k, v);
    localStorage.setItem("ghost-duels-sound", "off");
  }, [store, guest]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => void (m.type() === "error" && !/Failed to load resource|ERR_FAILED/.test(m.text()) && errors.push(m.text())));
  await chain.install(page);
  const lis = (id: number) => page.locator(`#lists li[data-id="${id}"]`).first();

  // First paint, before the game's wasm has arrived: no empty card, and the sound button already
  // says what this browser chose.
  chain.slowWasm = 1500;
  await page.goto(url);
  await page.waitForTimeout(500);
  const early = await page.evaluate(() => {
    const o = document.getElementById("overlay")!;
    return { card: getComputedStyle(o).display !== "none", text: o.textContent!.trim().slice(0, 20), mute: document.getElementById("mute")!.textContent };
  });
  check("while the game loads: no empty card, and the sound button says off", (!early.card || early.text !== "") && /off/.test(early.mute ?? ""), JSON.stringify(early));
  chain.slowWasm = 0;
  await until(page, "#overlay button", /Race ghost #1/);

  // A real duel: the start is held pending. Double-clicking Race sends one start_run; a link's
  // fragment changing meanwhile doesn't put the title back; the board's buttons wait.
  chain.slow.get_ghost = 500;
  let release = chain.hold("start_run");
  await page.locator("#overlay button", { hasText: "Race ghost #1" }).dblclick();
  await poll(() => chain.count("start_run") > 0);
  await page.waitForTimeout(800);
  check("double-clicking Race on a duel sends one start_run", chain.count("start_run") === 1, `${chain.count("start_run")} sent`);
  chain.slow.get_ghost = 0;
  await page.evaluate(() => void (location.hash = "#later"));
  await page.waitForTimeout(1500);
  check("…a board refresh meanwhile leaves the pending card up (no title over it)", (await page.locator("#overlay").getAttribute("class")) === "busy" && /Locking/.test(await text(page, "#overlay")), `${await page.locator("#overlay").getAttribute("class")}: ${(await text(page, "#overlay")).slice(0, 50)}`);
  await tap(lis(2).locator("button", { hasText: "Watch" }));
  await page.waitForTimeout(400);
  check("…and Watch on the board does nothing while the start is pending", (await gd(page))?.mode !== "watch", JSON.stringify(await gd(page)));
  release();
  await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { mode: string } | null }).__gd()?.mode === "race", null, { timeout: 10_000 }).catch(() => {});
  // During the real race (its countdown): Watch and Forget are refused, the run stays.
  await tap(lis(2).locator("button", { hasText: "Watch" }));
  await tap(page.locator("#you button", { hasText: "Forget this guest" }));
  await tap(page.locator("#you form.inline button", { hasText: "Forget it" }));
  await page.waitForTimeout(300);
  const mid = await gd(page);
  check("during a real race, Watch and Forget this guest don't abandon it", mid?.mode === "race" && /Playing as/.test(await text(page, "#you")), `${JSON.stringify(mid)}; ${(await text(page, "#you-status")).slice(0, 60)}`);
  // The ship falls (no input); the submit is held. The board's Race waits; the result lands on
  // the race it belongs to, never over another run.
  release = chain.hold("submit_run");
  await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { done: boolean } | null }).__gd()?.done, null, { timeout: 30_000 }).catch(() => {});
  await until(page, "#overlay", /Sending/, 5000);
  const starts = chain.count("start_run");
  await tap(lis(2).locator("button", { hasText: "Race (on chain, free)" }));
  await page.waitForTimeout(800);
  release();
  const settled = await until(page, "#overlay", /Paid out/, 10_000);
  await page.waitForTimeout(300);
  const after = await gd(page);
  check("while the submit is pending, the board's Race sends nothing", chain.count("start_run") === starts, `${chain.count("start_run") - starts} more start_run`);
  check("…and the result card shows on its own race, not over a new run", settled && after?.mode === "race" && !after.playing && after.countdown === 0, `${JSON.stringify(after)}; ${(await text(page, "#overlay")).slice(0, 60)}`);
  check("…saying Paid out: Lost, with the transaction", /Paid out: Lost/.test(await text(page, "#overlay")) && /see the transaction/.test(await text(page, "#overlay")), (await text(page, "#overlay")).match(/Paid out[^.]*/)?.[0] ?? "");
  // Race again, and the tab is hidden during the countdown: the chain's clock keeps going, so the
  // run ends at once (the button released) and is submitted.
  const submits = chain.count("submit_run");
  await tap(page.locator("#overlay button", { hasText: "Race again" }));
  await page.waitForFunction(() => ((globalThis as unknown as { __gd: () => { countdown: number; mode: string } | null }).__gd()?.countdown ?? 0) > 20, null, { timeout: 10_000 }).catch(() => {});
  // Plain JS in a string: tsx's transform would name the getter with a helper the page doesn't have.
  const hide = (h: boolean) => page.evaluate(`Object.defineProperty(document, "hidden", { configurable: true, value: ${h} }); document.dispatchEvent(new Event("visibilitychange"))`);
  await hide(true);
  await poll(async () => !!(await gd(page))?.done && chain.count("submit_run") > submits, 3000);
  const hid = await gd(page);
  await hide(false);
  check("a real race whose tab is hidden ends at once, and is submitted", !!hid?.done && hid.countdown === 0 && chain.count("submit_run") === submits + 1, JSON.stringify(hid));
  await until(page, "#overlay", /Paid out/, 10_000);
  // The start lands while the tab is already hidden: the run ends as soon as it begins.
  release = chain.hold("start_run");
  await tap(page.locator("#overlay button", { hasText: "Race again" }));
  await poll(() => chain.count("start_run") > starts);
  await hide(true);
  release();
  await poll(async () => chain.count("submit_run") > submits + 1, 5000);
  await hide(false);
  // Its submit is sent within a moment of the start landing, not after a countdown and a flight.
  const landed = chain.landed.filter((l) => l.method === "start_run").at(-1)?.at ?? 0;
  const sent = chain.calls.filter((c) => c.method === "submit_run").at(-1)?.at ?? 0;
  check("…and one whose start lands in a hidden tab ends as it begins", chain.count("submit_run") === submits + 2 && sent - landed < 1000, `submitted ${sent - landed} ms after the start landed`);
  await until(page, "#overlay", /Paid out/, 10_000);

  // Fly for a ghost (a duel): a double-click on Fly sends one start_run; a hash change after the
  // qualifier still opens an invite.
  await tap(page.getByRole("button", { name: "Back" }));
  await page.waitForTimeout(3000); // any run the page left flying ends
  await tap(page.getByRole("button", { name: "Back" }));
  await tap(page.locator("#you button", { hasText: "Fly for a ghost" }));
  await page.locator('input[name="kind"][value="duel"]').check({ timeout: 2000 }).catch(() => {});
  await page.locator("#f-names").fill("bob.testnet", { timeout: 2000 }).catch(() => {});
  chain.slow.get_balance = 600;
  const before = chain.count("start_run");
  await page.locator("#overlay button", { hasText: /^Fly$/ }).dblclick({ timeout: 2000 }).catch(() => {});
  await poll(() => chain.count("start_run") > before);
  await page.waitForTimeout(1200);
  check("double-clicking Fly sends one start_run", chain.count("start_run") - before === 1, `${chain.count("start_run") - before} sent`);
  const minted = await until(page, "#overlay", /GHOST #\d+|NO GHOST|NOT/, 30_000);
  check("…and the qualifier ends in its result", minted && /GHOST #6/.test(await text(page, "#overlay")), (await text(page, "#overlay")).slice(0, 60));
  await page.evaluate(() => void (location.hash = "#duel=1"));
  check("after a qualifier, opening an invite link shows the invite", await until(page, "#overlay", /You're invited/, 4000), (await text(page, "#overlay")).slice(0, 60));

  // Invites to what can't be raced say why.
  const invite = async (id: number) => {
    await page.evaluate((h) => void (location.hash = h), `#duel=${id}`);
    await poll(async () => (await text(page, "#overlay")).includes(`#${id}`), 4000);
    await page.waitForTimeout(200);
    return text(page, "#overlay");
  };
  let t = await invite(999);
  check("an invite to a ghost that doesn't exist says so", /#999/.test(t) && !/You're invited/.test(t), t.slice(0, 80));
  t = await invite(3);
  check("an invite to your own duel says it's yours", /your own/i.test(t) && !/send .* your account id/i.test(t), t.slice(0, 80));
  t = await invite(4);
  check("an invite to a duel that was beaten says it's closed", /beaten|closed/i.test(t) && !/You're invited/.test(t), t.slice(0, 80));
  t = await invite(2);
  check("an invite to a public-ladder ghost doesn't promise a pot", !/pot is yours/.test(t) && /Race ghost #2/.test(t), t.slice(0, 80));

  // The owner's buttons: Retire pressed twice while the first is pending sends one transaction.
  // Meanwhile the player starts typing in Cash out…: the board read after Retire leaves it be.
  release = chain.hold("retire_ghost");
  await tap(lis(3).locator("button", { hasText: "Retire" }));
  await page.waitForTimeout(300);
  await tap(lis(3).locator("button", { hasText: "Retire" }));
  // An owner's transaction is pending in "You", not on the screen: a link opened now still opens.
  await page.evaluate(() => void (location.hash = "#duel=1"));
  check("while an owner's transaction is pending, an invite link still opens", await until(page, "#overlay", /You're invited/, 5000), (await text(page, "#overlay")).slice(0, 60));
  await tap(page.locator("#you button", { hasText: "Cash out…" }));
  await page.locator("#you form.inline input").fill("me.testnet", { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(500);
  release();
  await until(page, "#you-status", /done|refused/, 5000);
  await page.waitForTimeout(800);
  check("Retire pressed twice sends one transaction", chain.count("retire_ghost") === 1, `${chain.count("retire_ghost")} sent`);
  check("…and the board read after it doesn't wipe a Cash out form being typed in", (await page.locator("#you form.inline input").inputValue({ timeout: 1000 }).catch(() => "")) === "me.testnet", (await text(page, "#you")).slice(0, 60));
  await tap(page.locator("#you form.inline button", { hasText: "Cancel" }));

  // The board loads slowly: the Fly form opened meanwhile isn't wiped when it arrives.
  await page.evaluate(() => void (location.hash = ""));
  chain.slow.get_ghosts = 2500;
  await page.reload();
  await until(page, "#overlay button", /Fly for a ghost/);
  await tap(page.locator("#overlay button", { hasText: "Fly for a ghost" }));
  await page.locator('input[name="kind"][value="duel"]').check({ timeout: 2000 }).catch(() => {});
  await page.locator("#f-names").fill("bob.testnet", { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(3500);
  check("the Fly form survives the board arriving", (await page.locator("#f-names").inputValue({ timeout: 1000 }).catch(() => "")) === "bob.testnet", (await text(page, "#overlay")).slice(0, 50));
  chain.slow.get_ghosts = 0;

  // An empty board: the title doesn't wait for ghosts forever.
  chain.ghosts = [];
  await page.reload();
  await poll(async () => /no ghost/i.test(await text(page, "#overlay").catch(() => "")), 6000);
  t = await text(page, "#overlay");
  check("an empty board: the title says there are no ghosts yet, not loading", !/Loading/.test(t) && /no ghost/i.test(t), t.slice(0, 90));
  reset();

  // No guest, and the faucet says no (429): the page says so, and Play for real is offered again.
  await page.evaluate(() => sessionStorage.setItem("no-guest", "1"));
  await page.evaluate((k) => localStorage.removeItem(k), store);
  await page.reload();
  await tap(page.locator("#you button", { hasText: "Play for real" }));
  await until(page, "#you-status", /faucet/, 10_000);
  check("the faucet says no: the page says so and offers Play for real again", /429/.test(await text(page, "#you-status")) && (await page.locator("#you button", { hasText: "Play for real" }).isEnabled()) && chain.faucet.length === 1, (await text(page, "#you-status")).slice(0, 80));
  // A free run: Space held, then the window loses focus (the key is let go elsewhere): the ship
  // doesn't keep climbing on a key this page will never hear released.
  await tap(page.getByRole("button", { name: "Practice", exact: true }));
  await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { playing: boolean } | null }).__gd()?.playing, null, { timeout: 10_000 }).catch(() => {});
  await page.keyboard.down("Space");
  await poll(async () => (await page.locator("#pad.down").count()) === 1, 2000);
  const down = await page.locator("#pad.down").count();
  await page.evaluate(() => dispatchEvent(new Event("blur")));
  await page.waitForTimeout(300);
  const stuck = await page.locator("#pad.down").count();
  await page.keyboard.up("Space");
  check("a key held when the window loses focus is let go", down === 1 && stuck === 0, `held ${down}, after blur ${stuck}`);
  check("no request left this machine", chain.escaped.length === 0, chain.escaped.slice(0, 2).join(" "));
  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 140));
  await ctx.close();
}

const browser = await chromium.launch();
// MOCK_ONLY=1 runs only the last pass (the mocked chain), while working on it.
for (const [name, viewport, phone, offline] of process.env.MOCK_ONLY ? [] : ([
  ["desktop, testnet RPC blocked", { width: 1280, height: 800 }, false, true],
  ["phone 390 px, testnet RPC blocked", { width: 390, height: 844 }, true, true],
  ["desktop, live testnet RPC", { width: 1280, height: 800 }, false, false],
] as const)) {
  console.log(`\n${name}`);
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // A blocked RPC request is this pass's own doing, not the page's fault.
    if (m.type() === "error" && !(offline && /Failed to load resource|ERR_FAILED/.test(m.text()))) errors.push(m.text());
  });
  if (offline) await page.route(/rpc|nearblocks/, (r) => r.abort());
  await page.goto(url);
  await page.waitForTimeout(1500);
  let s = await canvasStats(page);
  check("the title screen draws (not a black canvas)", s.black < 0.5 && s.colours > 8, `${(s.black * 100).toFixed(0)}% black, ${s.colours} colours`);
  const stage = (await page.locator("#stage").boundingBox())!;
  const btns = await page.locator("#overlay button").evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().toJSON()));
  const inside = btns.length > 0 && btns.every((b: DOMRect) => b.top >= stage.y - 1 && b.bottom <= stage.y + stage.height + 1);
  check("the title's buttons are inside the game frame", inside, `${btns.length} buttons`);
  check("the page doesn't scroll sideways", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const ways = (await page.locator(".ways").innerText()).replace(/\s+/g, " ");
  check("the page says you fly a cave of your own, and the ghost isn't in it", /fresh cave of yours/.test(ways) && /passes through your rock/.test(ways), ways.match(/You get a fresh cave[^.]*\./)?.[0].slice(0, 70) ?? "");
  const quiet = await sound(page);
  check("no sound, and no audio context, before the visitor's first input", quiet.context === "none" && quiet.played === 0, JSON.stringify(quiet));
  // A board refresh still in flight when a run starts (a link's #fragment changed, a slow RPC) must
  // not put the title card back over the run: the RPC answers late here, and the run begins meanwhile.
  const slow = async (r: Route) => {
    await new Promise((ok) => setTimeout(ok, 1200));
    await (offline ? r.abort() : r.continue()).catch(() => {});
  };
  await page.route(/rpc/, slow);
  await page.evaluate(() => void (location.hash = "#refresh"));
  await page.waitForTimeout(150);
  // On a phone the card and the touch pad sit under the screen: between them the stage must never
  // drop to the bare canvas for a frame (the page below would jump up and back).
  await page.evaluate(() => {
    const [stage, canvas] = [document.getElementById("stage")!, document.getElementById("game")!];
    const g = globalThis as unknown as { __bare: number };
    g.__bare = 0;
    new ResizeObserver(() => void (stage.getBoundingClientRect().height <= canvas.getBoundingClientRect().height + 1 && g.__bare++)).observe(stage);
  });
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  const flying = flyLikeAHuman(page, { phone, seed: viewport.width, maxMs: 9000 });
  await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { countdown: number } | null }).__gd()?.countdown === 0, null, { timeout: 10_000 });
  await page.waitForTimeout(3000);
  const st = await gdState(page);
  s = await canvasStats(page);
  check("Practice starts and the sim advances", !!st && st.tick > 60, st ? `tick ${st.tick}, ${st.score} pts` : "no run");
  check("…drawing the cave (not a black canvas)", s.black < 0.5 && s.colours > 8, `${(s.black * 100).toFixed(0)}% black, ${s.colours} colours`);
  await page.unroute(/rpc/, slow);
  check("…and a board refresh that lands mid-run leaves the run on screen (no title card over it)", !!st && st.tick > 60 && !/^title$/.test((await page.locator("#overlay").getAttribute("class")) ?? ""), `overlay: ${(await page.locator("#overlay").getAttribute("class")) || "(a result card)"}`);
  await flying;
  // Then let go: the ship falls and the run ends.
  await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { done: boolean } }).__gd()?.done, null, { timeout: 70_000 });
  await page.waitForTimeout(400);
  const over = (await page.locator("#overlay").innerText()).replace(/\s+/g, " ");
  check("the run ends with a result", /CRASHED|SURVIVED/.test(over), over.slice(0, 60));
  if (phone) {
    const bare = await page.evaluate(() => (globalThis as unknown as { __bare: number }).__bare);
    check("…and the screen never drops to the bare canvas between the run and its card", bare === 0, `${bare} frames without the pad or the card`);
  }
  // Sound: on after the first input, with a sound for the countdown and one for the crash; the
  // header's button turns it off (nothing more is scheduled) and on again.
  const loud = await sound(page);
  const end = await gdState(page) as unknown as { fx: { crashes: number } };
  check("sound starts with the first input: the countdown and the crash were played", loud.context === "running" && !loud.muted && loud.played >= 5 && end.fx.crashes === (/CRASHED/.test(over) ? 1 : 0), JSON.stringify(loud));
  await page.locator("#mute").click();
  await page.locator("#mute", { hasText: "off" }).waitFor({ timeout: 5000 });
  const off = await sound(page);
  const offLabel = await page.locator("#mute").innerText();
  await page.locator("#mute").click();
  await page.locator("#mute", { hasText: "on" }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
  const on = await sound(page);
  check("the sound button mutes and unmutes, and says which", off.muted && /off/.test(offLabel) && off.played === loud.played && !on.muted && /on/.test(await page.locator("#mute").innerText()) && on.played > off.played, `${offLabel} → ${await page.locator("#mute").innerText()}`);
  if (!offline) {
    await page.getByRole("button", { name: "Back" }).click();
    const net = await page.locator("#net").innerText();
    check(`the ghost list reads the live contract, ${live.version}`, net.startsWith(live.contract) && /private duels/.test(net) && /public ladder/.test(net), net.slice(0, 90));
    const heads = await page.locator("#lists h3").allInnerTexts();
    check("…in groups: the public ladder, other players' duels", heads.some((h) => /public ladder/.test(h)) && heads.some((h) => /duels/.test(h)), heads.map((h) => h.split(" (")[0]).join(" | "));
    const you = await page.locator("#you").innerText();
    check("a visitor is offered Play for real (a guest account), and nothing more", /Play for real/.test(you) && !/Playing as/.test(you), you.slice(0, 60));
    const duel = page.locator("#lists ol").last().locator("li").first();
    check("a stranger gets only a practice race against a duel", (await duel.locator("button").allInnerTexts()).join() === "Practice race,Watch", (await duel.locator("button").allInnerTexts()).join(", "));
    // Watch a ladder ghost: the page re-flies its on-chain inputs and checks them against the chain.
    await page.locator("#lists ol").first().locator("li").first().locator("button", { hasText: "Watch" }).click();
    const watched = await page.locator("#overlay", { hasText: /the same score the contract recorded|does not match/ }).innerText({ timeout: 70_000 }).catch(() => "");
    check("Watch re-flies a ghost and matches its on-chain score and log hash", /✓ the same score the contract recorded/.test(watched), watched.replace(/\s+/g, " ").slice(0, 70));
  }
  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 140));
  await ctx.close();
}
await mockedChain();
// The result first, then the cleanup.
console.log(bad === 0 ? `\nAll ${n} page checks passed.` : `\n${bad} of ${n} page checks failed.`);
await browser.close();
server.close();
process.exit(bad === 0 ? 0 : 1);
