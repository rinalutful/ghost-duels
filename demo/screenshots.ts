// `npm run screenshots -- <dir>`: the built page (web/dist) at 1440x900 and 390x844, in its key states:
// the first screen, a race against a real ghost (the moment), its result, Watch's check against the
// chain, an error (the testnet RPC blocked) and keyboard focus. Nothing is signed: the race is the
// free practice race against a ghost the chain holds, flown by a simple autopilot reading the page's
// `__gd` hook (a bot, only to reach the result screen). page-e2e's SHOTS=<dir> adds the real-money states.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium, type Page } from "playwright";

const root = new URL("../web/dist/", import.meta.url).pathname;
if (!existsSync(join(root, "index.html"))) throw new Error("web/dist is missing: npm run build:web");
const out = resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2] ?? "docs/screenshots/after");
mkdirSync(out, { recursive: true });
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]));
  const f = existsSync(p) && !p.endsWith("/") ? p : join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(f)] ?? "application/octet-stream");
  res.end(readFileSync(f));
}).listen(0);
await new Promise((ok) => server.once("listening", ok));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

/** Fly well (a bot: no reaction delay), so the race reaches "you beat the ghost". */
const autopilot = (page: Page) =>
  page.evaluate(`new Promise((resolve) => {
    let held = false;
    const key = (down) => dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code: "Space", cancelable: true }));
    const loop = () => {
      const st = globalThis.__gd();
      if (st && st.done) { if (held) key(false); return resolve(); }
      if (st && st.playing) {
        const want = st.y + st.vy * 6 > (st.ahead ?? 90);
        if (want !== held) { held = want; key(want); }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })`);

const browser = await chromium.launch();
const shot = async (page: Page, name: string, full = false) => {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
  console.log(`  ${name}.png`);
};
for (const [tag, viewport, phone] of [
  ["desktop", { width: 1440, height: 900 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const) {
  console.log(tag);
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
  let page = await ctx.newPage();
  await page.goto(url);
  // The first screen once the chain's ghosts are in.
  await page.locator(".ghosts li[data-id]").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3500); // the title's ghost and the board's flight lines

  await shot(page, `${tag}-1-first-screen`);
  await shot(page, `${tag}-1-full-page`, true);
  if (!phone) {
    // Keyboard: Tab reaches the race button, and its focus shows.
    for (let i = 0; i < 6 && !(await page.evaluate(() => document.activeElement?.classList.contains("primary"))); i++) await page.keyboard.press("Tab");
    await shot(page, `${tag}-6-keyboard-focus`);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  // The moment: race the featured ghost (a free practice race against its recorded run).
  await page.locator("#overlay button.primary").first().click();
  await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { playing: boolean } | null }).__gd()?.playing === true, null, { timeout: 30_000 });
  const flying = autopilot(page);
  await page.waitForTimeout(4500);
  await shot(page, `${tag}-2-race`);
  await flying;
  await page.waitForTimeout(900);
  await shot(page, `${tag}-3-result`);
  // The proof: Watch re-flies a ghost from its on-chain inputs and checks it against the chain.
  await page.getByRole("button", { name: "Back" }).click();
  await page.locator(".ghosts li[data-id]").first().locator("button", { hasText: "Watch" }).click();
  await page.waitForFunction(() => /the same score the contract recorded|does not match/.test(document.getElementById("overlay")?.innerText ?? ""), null, { timeout: 90_000 });
  await page.waitForTimeout(600);
  await shot(page, `${tag}-5-watch`);
  await page.close();
  // An error: the testnet RPC is unreachable.
  page = await ctx.newPage();
  await page.route(/rpc|nearblocks/, (r) => r.abort());
  await page.goto(url);
  await page.waitForTimeout(4000);
  await shot(page, `${tag}-4-offline`, true);
  await ctx.close();
}
await browser.close();
server.close();
console.log(`saved in ${out}`);
