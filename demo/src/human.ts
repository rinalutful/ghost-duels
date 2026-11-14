// A human-paced player for the page test and the demo video. It is NOT a person, and everything that
// uses it says so. It reads only what the page draws (the ship's height and the cave 60 px ahead, via
// the page's read-only `__gd` hook), decides every 70-110 ms, acts on what it saw ~150 ms earlier (a
// typical visual reaction time), aims with some error, and drives the real input: the Space key, or
// pointer events on a phone. It is meant to fly like a decent human: several hundred points, not a
// bot's 2000+.
import type { Page } from "playwright";

export type GD = { mode: string; tick: number; score: number; done: boolean; playing: boolean; countdown: number; y: number; vy: number; ahead: number | null } | null;
export const gdState = (page: Page) => page.evaluate(() => (globalThis as unknown as { __gd: () => GD }).__gd());

/** A small seeded PRNG, so a recorded take can be re-run with the same "hand". */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

export async function flyLikeAHuman(page: Page, opts: { phone?: boolean; seed?: number; maxMs?: number; aimError?: number; quitAt?: number } = {}) {
  const r = rng(opts.seed ?? 7);
  const t0 = Date.now();
  let held = false;
  const seen: { at: number; want: boolean }[] = [];
  const press = async (v: boolean) => {
    if (v === held) return;
    held = v;
    if (opts.phone) {
      if (v) await page.locator("#stage").dispatchEvent("pointerdown");
      else await page.evaluate(() => dispatchEvent(new PointerEvent("pointerup")));
    } else if (v) await page.keyboard.down("Space");
    else await page.keyboard.up("Space");
  };
  let bias = 0;
  while (Date.now() - t0 < (opts.maxMs ?? 70_000)) {
    const s = await gdState(page);
    if (s && !s.done && !s.playing && s.countdown > 0) {
      await page.waitForTimeout(50); // the 3-2-1 before the run
      continue;
    }
    if (!s || s.done || !s.playing) break;
    if (opts.quitAt && s.tick >= opts.quitAt) {
      await press(true);
      await page.waitForTimeout(100);
      continue;
    }
    // Aim drifts slowly (attention), plus a little noise each look.
    bias = bias * 0.9 + (r() - 0.5) * (opts.aimError ?? 6);
    const mid = (s.ahead ?? 90) + bias;
    seen.push({ at: Date.now(), want: s.y + s.vy * 15 > mid });
    // Act on the oldest look that is at least ~150 ms old.
    const due = seen.filter((x) => Date.now() - x.at >= 130 + r() * 50);
    if (due.length) {
      await press(due[due.length - 1].want);
      seen.splice(0, seen.indexOf(due[due.length - 1]) + 1);
    }
    await page.waitForTimeout(70 + r() * 40);
  }
  await press(false);
}

/** The same model, run inside the page on the game's own clock: it looks every 4-6 ticks and acts
 *  8-11 ticks (130-180 ms) later, exactly as `bot/` measures it (median 281 over 300 caves). Its
 *  key presses are dispatched as Space keydown/keyup events on the page, so a loaded machine slows
 *  the video, not the pilot's reflexes. Resolves when the run ends. */
export async function flyHumanModelInPage(page: Page, seed: number) {
  // Plain JS in a string: tsx's transform would add helpers the page doesn't have.
  await page.evaluate(`new Promise((resolve) => {
    let s = (${seed} >>> 0) || 1;
    const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
    let held = false, bias = 0, nextLook = 0;
    const queue = [];
    const key = (down) => dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code: "Space", cancelable: true }));
    const loop = () => {
      const st = globalThis.__gd();
      if (st && st.done) { if (held) key(false); return resolve(); }
      if (st && st.playing) {
        if (st.tick >= nextLook) {
          bias = bias * 0.9 + (r() - 0.5) * 6;
          queue.push([st.tick + 8 + Math.floor(r() * 3), st.y + st.vy * 15 > (st.ahead ?? 90) + bias]);
          nextLook = st.tick + 4 + Math.floor(r() * 3);
        }
        while (queue.length && queue[0][0] <= st.tick) {
          const want = queue.shift()[1];
          if (want !== held) { held = want; key(want); }
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })`);
}
