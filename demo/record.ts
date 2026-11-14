// `npm run record`: docs/demo/ghost-duels-demo.mp4 (1920x1080) and the screenshots. A real, staked
// race on NEAR testnet in a headless browser of its own: a fresh player gets a session key capped at
// 0.5 NEAR (the owner's funder pays), races the most beatable open ghost on the live contract (v4: a duel naming the player, or the public ladder), and the
// contract settles it. The pilot is demo/src/human.ts, a scripted human-paced controller, and the
// video says so on screen the whole time it flies. Captions are added for the video only.
// Needs web/dist built, Playwright's Chromium, ffmpeg, and the funder's key in the keychain.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { chromium, type Page } from "playwright";
import { flyHumanModelInPage } from "./src/human.ts";
import { N, addSessionKey, call, keyed, subAccount } from "./src/near.ts";
import { SESSION_METHODS, SHARED_CONTRACT, SHARED_FUNDER } from "./src/world.ts";

const root = new URL("../web/dist/", import.meta.url).pathname;
const out = new URL("../docs/demo/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]));
  const f = existsSync(p) && !p.endsWith("/") ? p : join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(f)] ?? "application/octet-stream");
  res.end(readFileSync(f));
}).listen(0);
await new Promise((ok) => server.once("listening", ok));

// A fresh player, as `npm run session` makes one, funded by the live deploy's funder (0.8 NEAR; `npm run reclaim` returns it).
// RECORD_PLAYER=<id> reuses an earlier one (its full-access key is in the keychain) with a new key.
const funder = keyed(process.env.RECORD_FUNDER ?? SHARED_FUNDER);
const player = process.env.RECORD_PLAYER ? keyed(process.env.RECORD_PLAYER) : await subAccount(funder, `rec-${Math.random().toString(36).slice(2, 7)}`, "0.8");
if (!process.env.RECORD_PLAYER) await call(player, SHARED_CONTRACT, "deposit", {}, BigInt(N("0.5")), 30n);
const key = await addSessionKey(player, SHARED_CONTRACT, SESSION_METHODS, "0.25");
await call(player, SHARED_CONTRACT, "set_key_cap", { public_key: KeyPair.fromString(key as KeyPairString).getPublicKey().toString(), cap: N("0.5") }, 1n, 30n);
console.log(`player ${player.id}: a new session key capped at 0.5 NEAR`);
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/#contract=${SHARED_CONTRACT}&session=${player.id}:${key}`;

const videoDir = join(tmpdir(), `gd-video-${Date.now()}`);
mkdirSync(videoDir, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();
const wait = (ms: number) => page.waitForTimeout(ms);

async function caption(p: Page, text: string): Promise<void> {
  await p.evaluate((t) => {
    let d = document.getElementById("video-caption");
    if (!d) {
      d = document.createElement("div");
      d.id = "video-caption";
      d.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99;background:#1b1714;border-top:3px solid #ff5a1f;color:#f2ecdf;font:500 26px/1.35 'Atkinson Hyperlegible Next',system-ui,sans-serif;padding:18px 40px;text-align:center";
      document.body.appendChild(d);
    }
    d.textContent = t;
  }, text);
}
async function label(p: Page, text: string | null): Promise<void> {
  await p.evaluate((t) => {
    let d = document.getElementById("video-label");
    if (!t) return d?.remove();
    if (!d) {
      d = document.createElement("div");
      d.id = "video-label";
      d.style.cssText = "position:fixed;right:24px;top:20px;z-index:99;background:#ff5a1f;color:#1b1714;border:2px solid #1b1714;font:700 20px/1.3 'Atkinson Hyperlegible Mono',ui-monospace,monospace;padding:8px 14px;border-radius:3px";
      document.body.appendChild(d);
    }
    d.textContent = t;
  }, text);
}

await page.goto(url);
await page.waitForSelector(".ghosts li[data-id]", { timeout: 30_000 });
await page.waitForSelector("#overlay button.primary");
await caption(page, "Ghost Duels: stake to beat a recorded run. This player's app holds a session key capped at 0.5 NEAR: no wallet pop-ups mid-game.");
await wait(5500);
await page.screenshot({ path: join(out, "1-title.png") });
await caption(page, "Each ghost is an NFT on NEAR testnet with a pot. A challenger who falls short pays its owner, and a quarter of the stake grows the pot.");
await wait(5000);
const raceLabel = (await page.locator("#overlay button.primary").innerText()).trim();
await caption(page, `${raceLabel}: start_run locks the 0.1 NEAR stake first, then draws the cave from the block's randomness.`);
await page.locator("#overlay button.primary").click();
await page.waitForFunction(() => (globalThis as unknown as { __gd: () => { countdown: number } | null }).__gd()?.countdown !== undefined, null, { timeout: 60_000 });
await label(page, "INPUT: a scripted human-paced player (reacts in 130-180 ms). Not a person.");
await caption(page, "The ghost (blue) flies its recorded run level with you. Beat its score and its pot is yours.");
const flight = flyHumanModelInPage(page, Number(process.env.PILOT_SEED ?? 7));
await wait(9000);
await page.screenshot({ path: join(out, "2-race.png") });
await flight;
await label(page, null);
await caption(page, "submit_run sends only the button presses. The contract replays them itself, in the same transaction, and pays out.");
await page.waitForFunction(() => /Paid out|refused/.test(document.getElementById("overlay")?.innerText ?? ""), null, { timeout: 90_000 });
const result = (await page.locator("#overlay").innerText()).replace(/\s+/g, " ");
console.log(`result: ${result}`);
await wait(1500);
await page.screenshot({ path: join(out, "3-result.png") });
await wait(5500);
await page.getByRole("button", { name: "Back" }).click();
await wait(2500);
await caption(page, "The ghost's record is computed live from the chain: defences, the closest call, what it earned, how its pot grew.");
await page.locator(".board").scrollIntoViewIfNeeded();
await wait(5500);
await caption(page, "Watch: the page re-flies a ghost's recorded inputs on its seed and checks them against the on-chain hash.");
const watch = page.locator(".ghosts li", { hasText: `${raceLabel.replace("Race ghost ", "")} ` }).locator("button", { hasText: "Watch" }).first();
await (await watch.count() ? watch : page.locator(".ghosts li button", { hasText: "Watch" }).first()).click();
await page.waitForFunction(() => /GHOST #/.test(document.getElementById("overlay")?.innerText ?? "") && !document.getElementById("overlay")?.classList.contains("hidden"), null, { timeout: 70_000 });
await wait(5000);
await caption(page, "Built at NEAR HACKATHON. Run it yourself: npm run judge (free, no keys).");
await wait(4000);
await ctx.close();
await browser.close();
server.close();

const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
if (!webm) throw new Error("no video recorded");
const mp4 = join(out, "ghost-duels-demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(videoDir, webm), "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
rmSync(videoDir, { recursive: true, force: true });
const secs = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString());
console.log(`${mp4}: ${(statSync(mp4).size / 1e6).toFixed(1)} MB, ${secs.toFixed(0)} s, 1920x1080`);
