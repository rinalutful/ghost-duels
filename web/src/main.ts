// Ghost Duels in the browser. The simulation is the Rust crate compiled to wasm (sim.ts); this file
// only feeds it the button and draws what it says. Ways to play:
//   - Race ghost #N: your own cave (a fresh seed, as the contract draws), with the ghost's recorded
//     run flying alongside, translucent, and a live score against it. Beat its score.
//   - Practice: a local random cave, no ghost.
//   - Watch ghost #N: its recorded inputs replayed on its seed. The page checks the log's hash
//     against the chain and the replayed score against the ghost's: the same check the contract makes.
//   - Fly for a ghost: a qualifier. Its cave is drawn by the contract; 100+ points mint a ghost, on
//     the public ladder (no money) or as a private duel naming who may race it (docs/decisions/0019).
// "Play for real" makes a testnet guest account (chain.ts): races are then real. start_run locks the
// stake and draws the cave; submit_run sends the inputs, and the contract replays them and pays out
// in the same transaction. Without a guest, a race is a free practice race against the real ghost.
//
// The look: ink on paper, two corners. You fly in signal orange, the ghost in blue, and the cave and
// the type are ink. The title screen flies the featured ghost's recorded run (attract mode), and the
// board draws each ghost's recorded flight as a line: both are replays of the chain's logs here.
import { LIVE_VERSION, callGame, callRun, readGhost, readGhostLog, readGhosts, readRun, cashOut, CONTRACT, EXPLORER, forgetGuest, fragmentSession, lastTx, makeGuest, near, pendingGuest, storedGuest, V4, view, yocto, type Ghost, type Guest, type Run, type Signer } from "./chain.ts";
import { canRace, cleanLog, qualifierShortfall, ghostKind, ghostState, inviteLink, msLeft, mustEndNow, qualifyArgs, startArgs } from "./rules.ts";
import * as sound from "./sound.ts";
import { COL_W, logBytes, MAX_TICKS, Sim, SHIP_X, TICK_HZ, VIEW_H, VIEW_W } from "./sim.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
// The canvas holds 4x the playfield's pixels, so text stays sharp; the game draws in 320x180 units.
const SCALE = canvas.width / VIEW_W;
const overlay = $<HTMLDivElement>("overlay");
const stage = $<HTMLDivElement>("stage");
const pad = $<HTMLDivElement>("pad");
// The header's sound button, set before anything loads: its choice is kept in this browser.
const mute = $<HTMLButtonElement>("mute");
const showMute = () => {
  mute.textContent = sound.isMuted() ? "Sound: off" : "Sound: on";
  mute.setAttribute("aria-pressed", String(!sound.isMuted()));
};
mute.onclick = async () => {
  await sound.setMuted(!sound.isMuted());
  showMute();
  if (!sound.isMuted()) sound.gem(); // so turning it on is heard
};
showMute();
const wasm = await (await fetch(`${import.meta.env.BASE_URL}ghost_sim_web.wasm`)).arrayBuffer();
const sim = await Sim.load(wasm);
/** The title screen's flight and the board's flight lines run in instances of their own, so the
 *  player's game is never touched by them. */
const demo = await Sim.load(wasm);
const liner = await Sim.load(wasm);
/** Who plays for real: a guest this browser holds (both keys), or a session key from the URL. */
type Player = { id: string; session: Signer; full: Signer | null; sessionPk: string | null };
let me: Player | null = await storedGuest().then((g) => (g ? asPlayer(g) : null), () => null);
if (!me) me = await fragmentSession().then((s) => (s ? { id: s.id, session: s, full: null, sessionPk: null } : null), () => null);
function asPlayer(g: Guest): Player {
  return { id: g.id, session: g.session, full: g.full, sessionPk: g.sessionPk };
}

// The palette, for the canvas (style.css has the same).
const C = { paper: "#f2ecdf", ridge: "#e5dcc8", ridge2: "#dbd0b8", ink: "#1b1714", ink2: "#3b332b", you: "#ff5a1f", ghost: "#2c55c9", ghostLight: "#a9bcf5", muted: "#c9bfa9" };
const DISPLAY = "Bungee, 'Arial Black', Impact, sans-serif";
const MONO = "'Atkinson Hyperlegible Mono', ui-monospace, Menlo, monospace";
for (const f of [`10px Bungee`, `10px "Atkinson Hyperlegible Mono"`]) document.fonts?.load(f).catch(() => {});
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

type GhostRun = { info: Ghost; seed: Uint8Array; log: number[] };
type Mode = { kind: "practice" } | { kind: "race"; ghost: GhostRun; real: Run | null } | { kind: "watch"; ghost: GhostRun } | { kind: "qualify"; real: Run; duel: boolean };
let mode: Mode = { kind: "practice" };
let started = false;
let playing = false;
let countdown = 0; // ticks of "3, 2, 1" left before a run starts
let held = false;
let ghostIdx = 0;
let ghostHeld = false;
let ghostDown: { x: number; score: number } | null = null;
let ghosts: Ghost[] = [];
let board: "loading" | "ok" | "error" = "loading";
let cfg: { replay_fee: string } = { replay_fee: "0" };
/** When start_run's result arrived here (a real race), for the deadline guard. */
let startedLocal = 0;
type Pt = { x: number; y: number };
const youTrail: Pt[] = [];
const ghostTrail: Pt[] = [];
const TRAIL = 150;
const sparks: { x: number; y: number; vx: number; vy: number; life: number; c: string }[] = [];
/** The title screen's flight: the featured ghost's recorded run on its own cave, or (before the
 *  board loads, or without a network) a simple autopilot on a random cave. */
let attract: { ghost: GhostRun | null; idx: number; held: boolean; rest: number } | null = null;
const attractTrail: Pt[] = [];
// The run's small effects: a "+25" where a gem was taken, a shake when you crash, and a banner the
// moment your score passes the ghost's. Sounds go with each (sound.ts); none of it touches the sim.
const pops: { x: number; y: number; life: number; s: string }[] = [];
let flown = 0; // runs begun in this visit
let lastGems = 0;
let passed = false;
let ahead = 0; // frames the "ahead" banner has left
let shake = 0; // frames of screen shake left
const fx = { gems: 0, passes: 0, crashes: 0 };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const sha256 = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource)));
/** How a kept stake splits in a duel (the deployed rake 5%, pot share 25%: docs/decisions/0009). */
const splitOf = (stake: string) => {
  const s = Number(near(stake));
  return { owner: s * 0.7, pot: s * 0.25, house: s * 0.05 };
};

// ---------- input ----------
// The button counts during the countdown too: whoever is already holding when the run starts is
// climbing from its first tick (a released button drops the ship into the floor within a second,
// which is how most first runs used to end).
const press = (v: boolean) => (e: Event) => {
  if (!playing && countdown === 0) return;
  e.preventDefault();
  held = v;
};
// Space is the button, always: it never scrolls the page or clicks a focused overlay button (but it
// still types a space in a text field).
const space = (v: boolean) => (e: KeyboardEvent) => {
  if (e.code !== "Space" || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  press(v)(e);
};
// The first key or touch anywhere lets the sounds start (never before: sound.ts).
addEventListener("keydown", () => sound.unlock());
addEventListener("pointerdown", () => sound.unlock(), { passive: true });
addEventListener("keydown", space(true));
addEventListener("keyup", space(false));
stage.addEventListener("pointerdown", press(true));
addEventListener("pointerup", press(false));
addEventListener("pointercancel", press(false));
// A key let go in another window never comes back as a keyup here.
addEventListener("blur", () => (held = false));

// ---------- the loop: 60 fixed ticks a second, drawing every frame ----------
let acc = 0;
let attractAcc = 0;
let last = performance.now();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  acc += dt;
  while ((playing || countdown > 0) && acc >= 1 / TICK_HZ) {
    acc -= 1 / TICK_HZ;
    if (countdown > 0) {
      if (mode.kind !== "watch" && countdown % TICK_HZ === 0) sound.count(false);
      if (--countdown === 0) {
        playing = true;
        if (mode.kind !== "watch") sound.count(true);
      }
      continue;
    }
    tick();
  }
  if (!playing && countdown === 0) acc = 0;
  if (attract && !still) {
    attractAcc += dt;
    while (attract && attractAcc >= 1 / TICK_HZ) {
      attractAcc -= 1 / TICK_HZ;
      attractStep();
    }
  }
  stage.classList.toggle("playing", playing || countdown > 0);
  pad.classList.toggle("down", held && playing);
  draw();
  requestAnimationFrame(frame);
}

const keep = (t: Pt[], p: Pt) => {
  t.push(p);
  if (t.length > TRAIL) t.shift();
};

function tick() {
  if (mode.kind === "watch") {
    stepGhost(0, mode.ghost);
    keep(ghostTrail, { x: sim.cam(0) + SHIP_X, y: sim.y(0) });
  } else {
    sim.step(0, held);
    if (sim.alive(0)) keep(youTrail, { x: sim.cam(0) + SHIP_X, y: sim.y(0) });
    if (sim.gems(0) > lastGems) {
      lastGems = sim.gems(0);
      fx.gems++;
      sound.gem();
      pops.push({ x: sim.cam(0) + SHIP_X, y: sim.y(0) - 7, life: 45, s: "+25" });
    }
    if (mode.kind === "race" && !passed && sim.score(0) > mode.ghost.info.score) {
      passed = true;
      fx.passes++;
      ahead = 110;
      sound.pass();
    }
    if (mode.kind === "race") stepGhost(1, mode.ghost);
  }
  if (sim.done(0)) return void finish();
  const real = mode.kind === "race" || mode.kind === "qualify" ? mode.real : null;
  if (real && mustEndNow(msLeft(real, startedLocal, Date.now()), false)) endNow();
}

/** A real run that must end now (its deadline is near, or the tab was hidden, which stops the game
 *  clock but not the chain's): the button is released and the ship flies on to its crash, so the
 *  submitted log and score are honest, and the submit lands before the deadline. */
function endNow() {
  if (!playing && countdown === 0) return;
  countdown = 0;
  while (!sim.done(0)) sim.step(0, false);
  finish();
}
document.addEventListener("visibilitychange", () => {
  const real = mode.kind === "race" || mode.kind === "qualify" ? mode.real : null;
  if (real && (playing || countdown > 0) && mustEndNow(Infinity, document.hidden)) endNow();
});

/** Advance a slot along a recorded log (the button flips at each logged tick). */
function stepGhost(slot: number, g: GhostRun) {
  if (sim.done(slot)) return;
  if (ghostIdx < g.log.length && g.log[ghostIdx] === sim.tick(slot)) {
    ghostHeld = !ghostHeld;
    ghostIdx++;
  }
  sim.step(slot, ghostHeld);
  if (slot === 1) {
    if (sim.alive(1)) keep(ghostTrail, { x: sim.cam(1) + SHIP_X, y: sim.y(1) });
    if (sim.done(1) && !sim.alive(1)) {
      ghostDown = { x: sim.cam(1) + SHIP_X, score: sim.score(1) };
      burst(SHIP_X, sim.y(1), C.ghost);
      sound.ghostDown();
    }
  }
}

function burst(x: number, y: number, c: string) {
  for (let i = 0; i < 26; i++) sparks.push({ x, y, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, life: 30 + Math.random() * 20, c: i % 3 ? c : C.ink });
}

// ---------- the title screen's flight ----------
function attractStart(g: GhostRun | null) {
  attract = { ghost: g, idx: 0, held: false, rest: 0 };
  attractTrail.length = 0;
  sparks.length = 0;
  demo.newGame(0, g ? g.seed : randomSeed());
  if (still) for (let i = 0; i < 170 && attract; i++) attractStep(); // one still frame, part-way in
}

function attractStep() {
  const a = attract!;
  if (demo.done(0)) {
    if (++a.rest > 90) attractStart(a.ghost);
    return;
  }
  if (a.ghost) {
    if (a.idx < a.ghost.log.length && a.ghost.log[a.idx] === demo.tick(0)) {
      a.held = !a.held;
      a.idx++;
    }
  } else {
    // sim.ts's autopilot, a tick at a time: aim for the middle of the cave a little ahead.
    const c = demo.col(0, Math.floor((demo.cam(0) + SHIP_X + 60) / COL_W));
    a.held = demo.y(0) + demo.vy(0) * 12 > (c ? (c.top + c.bot) / 2 : VIEW_H / 2);
  }
  demo.step(0, a.held);
  if (demo.alive(0)) keep(attractTrail, { x: demo.cam(0) + SHIP_X, y: demo.y(0) });
  else if (demo.done(0)) burst(SHIP_X, demo.y(0), a.ghost ? C.ghost : C.you);
}

// ---------- drawing ----------
function text(s: string, x: number, y: number, color: string, size = 8, align: CanvasTextAlign = "left", font = MONO, halo: string | null = null) {
  ctx.font = `${font === MONO ? "700 " : ""}${size}px ${font}`;
  ctx.textAlign = align;
  if (halo) {
    ctx.lineWidth = size / 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = halo;
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.textAlign = "left";
}
const width = (s: string, size: number, font = MONO) => {
  ctx.font = `${font === MONO ? "700 " : ""}${size}px ${font}`;
  return ctx.measureText(s).width;
};

/** Paper sky, and two far ridges that scroll slower than the cave. */
function drawSky(cam: number) {
  const g = ctx;
  g.fillStyle = C.paper;
  g.fillRect(0, 0, VIEW_W, VIEW_H);
  const ridge = (off: number, base: number, amp: number, top: boolean, color: string) => {
    g.beginPath();
    g.moveTo(0, top ? 0 : VIEW_H);
    for (let x = 0; x <= VIEW_W + 4; x += 4) {
      const w = x + off;
      g.lineTo(x, base + amp * (0.6 * Math.sin(w / 41) + 0.4 * Math.sin(w / 17 + 1.7)));
    }
    g.lineTo(VIEW_W + 4, top ? 0 : VIEW_H);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  ridge(cam * 0.2 + 300, 34, 14, true, C.ridge);
  ridge(cam * 0.2, 148, 16, false, C.ridge);
  ridge(cam * 0.45 + 90, 160, 10, false, C.ridge2);
}

/** The cave (ink) and its gems, from a sim's columns. */
function drawCave(s: Sim, cam: number) {
  const g = ctx;
  const k0 = Math.floor(cam / COL_W);
  const cols: { x: number; top: number; bot: number; gem: number | null }[] = [];
  for (let k = k0; k <= k0 + VIEW_W / COL_W + 1; k++) {
    const c = s.col(0, k);
    if (c) cols.push({ x: k * COL_W - cam, ...c });
  }
  for (const side of ["top", "bot"] as const) {
    g.beginPath();
    g.moveTo(cols[0]?.x ?? 0, side === "top" ? 0 : VIEW_H);
    for (const c of cols) {
      g.lineTo(c.x, c[side]);
      g.lineTo(c.x + COL_W, c[side]);
    }
    g.lineTo(VIEW_W + COL_W, side === "top" ? 0 : VIEW_H);
    g.closePath();
    g.fillStyle = C.ink;
    g.fill();
  }
  const t = performance.now() / 200;
  for (const c of cols) {
    if (c.gem === null) continue;
    const x = c.x + COL_W / 2;
    const y = c.gem + (still ? 0 : Math.sin(t + c.x) * 0.8);
    g.fillStyle = C.ink;
    g.beginPath();
    g.moveTo(x, y - 4.5);
    g.lineTo(x + 3.2, y);
    g.lineTo(x, y + 4.5);
    g.lineTo(x - 3.2, y);
    g.fill();
    g.fillStyle = C.you;
    g.fillRect(x - 1.2, y - 2, 1.4, 1.4);
  }
}

/** A trail: yours a fading orange line, a ghost's fading blue dots. */
function drawTrail(pts: Pt[], cam: number, color: string, dots: boolean) {
  const g = ctx;
  const n = pts.length;
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 1.5;
  g.lineCap = "round";
  for (let i = 1; i < n; i++) {
    g.globalAlpha = (i / n) * (dots ? 0.85 : 0.75);
    if (dots) {
      if (i % 3) continue;
      g.beginPath();
      g.arc(pts[i].x - cam, pts[i].y, 0.95, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(pts[i - 1].x - cam, pts[i - 1].y);
      g.lineTo(pts[i].x - cam, pts[i].y);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
}

function drawShip(y: number, flame: boolean) {
  const g = ctx;
  if (flame) {
    g.fillStyle = Math.random() < 0.5 ? C.you : C.ink;
    g.fillRect(SHIP_X - 9 - Math.random() * 3, y - 1, 4, 2);
  }
  g.fillStyle = C.you;
  g.strokeStyle = C.ink;
  g.lineWidth = 0.9;
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(SHIP_X + 6, y);
  g.lineTo(SHIP_X - 5, y - 4.5);
  g.lineTo(SHIP_X - 3, y);
  g.lineTo(SHIP_X - 5, y + 4.5);
  g.closePath();
  g.fill();
  g.stroke();
}

function drawGhost(x: number, y: number, a: number) {
  const g = ctx;
  g.globalAlpha = a;
  g.fillStyle = C.ghost;
  g.beginPath();
  g.arc(x, y - 1, 4.5, Math.PI, 0);
  g.lineTo(x + 4.5, y + 4.5);
  g.lineTo(x + 2.2, y + 3.2);
  g.lineTo(x, y + 4.5);
  g.lineTo(x - 2.2, y + 3.2);
  g.lineTo(x - 4.5, y + 4.5);
  g.closePath();
  g.fill();
  g.fillStyle = C.paper;
  g.fillRect(x - 2.4, y - 2.6, 1.6, 2.4);
  g.fillRect(x + 0.8, y - 2.6, 1.6, 2.4);
  g.globalAlpha = 1;
}

function drawSparks() {
  const g = ctx;
  for (const s of sparks) {
    if (!still) {
      s.x += s.vx;
      s.y += s.vy;
    }
    s.life--;
    g.fillStyle = s.c;
    g.globalAlpha = Math.max(0, s.life / 50);
    g.fillRect(s.x, s.y, 2, 2);
  }
  g.globalAlpha = 1;
  for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].life <= 0) sparks.splice(i, 1);
}

/** A small ink tag in a corner of the screen. */
function tag(s: string, x: number, y: number, align: "left" | "right", bg = C.ink, fg = C.paper) {
  const w = width(s, 6.5);
  const left = align === "left" ? x : x - w - 8;
  ctx.fillStyle = bg;
  ctx.fillRect(left, y, w + 8, 11);
  text(s, left + 4, y + 8, fg, 6.5);
}

function draw() {
  const g = ctx;
  g.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  if (attract) return drawAttract();
  if (shake > 0) {
    // A crash shakes the screen for a quarter of a second (not with reduced motion: `shake` stays 0).
    g.translate((Math.random() - 0.5) * shake * 0.5, (Math.random() - 0.5) * shake * 0.5);
    shake--;
  }
  // Slot 0 exists only once a run has begun: before that the camera is at 0.
  const cam = started ? sim.cam(0) : 0;
  drawSky(cam);
  if (!started) return;
  drawCave(sim, cam);
  // The ghost: its recorded flight, drawn in YOUR cave. It flew a different cave (every run draws
  // its own), so it is a pace marker: always level with you (distance depends only on time), at
  // the height it flew, passing through your rock. Its score is what you must beat.
  if (mode.kind === "race") {
    drawTrail(ghostTrail, cam, C.ghost, true);
    if (ghostDown) {
      const x = ghostDown.x - cam;
      g.strokeStyle = C.ghost;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(x, 18);
      g.lineTo(x, VIEW_H);
      g.stroke();
      g.setLineDash([]);
      if (x > -90) text("ghost crashed here", x + 3, 28, C.ghost, 6.5, "left", MONO, C.paper);
    }
  }
  if (mode.kind !== "watch") drawTrail(youTrail, cam, C.you, false);
  if (mode.kind === "race" && !sim.done(1)) {
    drawGhost(SHIP_X, sim.y(1), 0.78);
    // Its name sits on the far side from your ship, so the two never overlap.
    const above = sim.y(1) <= sim.y(0);
    text(`ghost #${mode.ghost.info.id}`, SHIP_X, sim.y(1) + (above ? -9 : 13), C.ghost, 6, "center", MONO, C.paper);
  }
  // The ship (or, watching, the ghost itself).
  if (mode.kind === "watch") {
    drawTrail(ghostTrail, cam, C.ghost, true);
    if (sim.alive(0) || !sim.done(0)) drawGhost(SHIP_X, sim.y(0), 0.95);
  } else if (sim.alive(0)) drawShip(sim.y(0), held && playing);
  drawSparks();
  for (const p of pops) {
    g.globalAlpha = Math.min(1, p.life / 20);
    text(p.s, p.x - cam, p.y - (45 - p.life) * 0.35, C.you, 8, "center", DISPLAY, C.paper);
    p.life--;
  }
  g.globalAlpha = 1;
  for (let i = pops.length - 1; i >= 0; i--) if (pops[i].life <= 0) pops.splice(i, 1);
  hud();
  if (ahead > 0 && mode.kind === "race") {
    const s = `AHEAD OF GHOST #${mode.ghost.info.id}`;
    const w = width(s, 9, DISPLAY);
    g.globalAlpha = Math.min(1, ahead / 25);
    g.fillStyle = C.you;
    g.fillRect(VIEW_W / 2 - w / 2 - 6, 24, w + 12, 14);
    text(s, VIEW_W / 2, 34.5, C.ink, 9, "center", DISPLAY);
    g.globalAlpha = 1;
    ahead--;
  }
  if (countdown > 0) {
    const n = String(Math.ceil(countdown / TICK_HZ));
    text(n, VIEW_W / 2, VIEW_H / 2 + 10, C.ink, 36, "center", DISPLAY, C.paper);
    const last = countdown <= TICK_HZ;
    const hint = last ? (held ? "holding: you'll climb" : "HOLD NOW to climb") : mode.kind === "race" ? "your own fresh cave · the ghost shows its pace · beat its score" : "hold to climb · let go to fall";
    const w = width(hint, 7);
    g.fillStyle = C.paper;
    g.fillRect(VIEW_W / 2 - w / 2 - 6, VIEW_H / 2 + 19, w + 12, 12);
    text(hint, VIEW_W / 2, VIEW_H / 2 + 27.5, last && !held ? C.you : C.ink, 7, "center");
  }
}

function drawAttract() {
  const a = attract!;
  const cam = demo.cam(0);
  drawSky(cam);
  drawCave(demo, cam);
  drawTrail(attractTrail, cam, a.ghost ? C.ghost : C.you, !!a.ghost);
  if (demo.alive(0)) {
    if (a.ghost) drawGhost(SHIP_X, demo.y(0), 0.95);
    else drawShip(demo.y(0), a.held);
  }
  drawSparks();
  if (a.ghost) {
    tag(`GHOST #${a.ghost.info.id} · ITS RECORDED RUN`, 6, 6, "left");
    tag(`${demo.score(0)} / ${a.ghost.info.score}`, VIEW_W - 6, 6, "right", C.ghost);
  }
}

/** The bar on top: your score, the ghost's live score against its record, and what's at stake. */
function hud() {
  const g = ctx;
  g.fillStyle = C.ink;
  g.fillRect(0, 0, VIEW_W, 17);
  const you = sim.score(0);
  if (mode.kind === "watch") {
    text(`GHOST #${mode.ghost.info.id}`, 6, 12.5, C.ghostLight, 9, "left", DISPLAY);
    text(`replaying its recorded run · ${you} pts · ${mode.ghost.info.score} recorded`, 12 + width(`GHOST #${mode.ghost.info.id}`, 9, DISPLAY), 11.5, C.paper, 6.5);
  } else {
    text(`${you}`, 6, 13, C.you, 10, "left", DISPLAY);
    text(`pts · ${sim.metres(0)} m · ${sim.gems(0)} gems`, 11 + width(`${you}`, 10, DISPLAY), 11.5, C.paper, 6.5);
  }
  if (mode.kind === "race") {
    const info = mode.ghost.info;
    const target = info.score;
    const real = mode.real !== null;
    const winning = you > target;
    const ladder = ghostKind(info) === "ladder";
    text(`to beat ${target}`, 150, 11.5, C.ghostLight, 6.5);
    const chip = ladder ? "public ladder · no stake" : !real ? `practice · ${near(winning ? info.pot : info.stake)} if staked` : winning ? `${near(info.pot)} pot: yours` : `${near(info.stake)} NEAR at stake`;
    const w = width(chip, 6.5);
    g.fillStyle = winning && !ladder ? C.you : real && !ladder ? "#7a2a10" : C.ink2;
    g.fillRect(VIEW_W - w - 12, 3, w + 8, 11);
    text(chip, VIEW_W - 8, 11, winning && !ladder ? C.ink : C.paper, 6.5, "right");
    // Progress toward the ghost's score.
    g.fillStyle = C.ink2;
    g.fillRect(0, 17, VIEW_W, 2);
    g.fillStyle = winning ? C.you : C.ghostLight;
    g.fillRect(0, 17, VIEW_W * Math.min(1, you / Math.max(1, target)), 2);
  } else {
    if (mode.kind === "qualify") text("for a ghost: 100+ keeps it", 150, 11.5, C.you, 6.5);
    g.fillStyle = C.ink2;
    g.fillRect(0, 17, VIEW_W, 1.5);
    g.fillStyle = mode.kind === "watch" ? C.ghostLight : C.you;
    g.fillRect(0, 17, (VIEW_W * sim.tick(0)) / MAX_TICKS, 1.5);
  }
}

// ---------- flow ----------

// ---------- one thing at a time ----------
/** A start, a submit or an owner's transaction is on its way to the chain. */
let waiting = false;
/** Counts the screens shown: an answer that arrives after the screen has moved on is dropped. */
let shown = 0;
const realRun = () => (mode.kind === "race" || mode.kind === "qualify") && mode.real !== null && (playing || countdown > 0);
/** Nothing new starts while a real race flies or a transaction is pending: say so, and refuse.
 *  Something free (Watch, a practice race) waits only for a real race and its own pending card. */
let refusal = "";
function blocked(free = false): boolean {
  const run = realRun();
  if (!run && !(free ? overlay.className === "busy" : waiting)) return false;
  // An owner's transaction already says it is pending (the waiting dots): leave that line be.
  if (!$("you-status").querySelector(".wait")) status((refusal = run ? "Your race is real: finish it first." : "Wait: a transaction is still on its way."), "bad");
  return true;
}
/** A free run in flight just stops (a real race was opened from the board, or the Fly form). */
function leaveFreeRun() {
  playing = false;
  countdown = 0;
  held = false;
}

type Btn = [string, () => void, boolean?];
function show(html: string, buttons: Btn[] = [], kind: "title" | "card" | "busy" = "card", redraw = false) {
  if (!redraw) shown++;
  if (refusal && $("you-status").textContent === refusal) status("");
  refusal = "";
  overlay.innerHTML = html;
  const row = document.createElement("div");
  row.className = "btns";
  let first: HTMLButtonElement | null = null;
  for (const [label, fn, primary] of buttons) {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.onclick = (e) => {
      e.stopPropagation();
      b.blur();
      fn();
    };
    row.append(b);
    if (primary && !first) first = b;
  }
  if (buttons.length) overlay.append(row);
  overlay.className = kind;
  // After a run, the keyboard lands on the next step (Enter races again); the title leaves focus be.
  if (kind === "card" && first && overlay.contains(document.activeElement) === false && document.activeElement === document.body) first.focus({ preventScroll: true });
}
const busy = (s: string) => `<p class="lead"><span class="wait" aria-hidden="true"><i></i><i></i><i></i></span>${s}</p>`;
/** Bring the game screen into view (a race started from the board, far down a phone's page). */
function reveal() {
  const r = stage.getBoundingClientRect();
  if (r.top < 0 || r.top > innerHeight * 0.6) stage.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
}

function begin(m: Mode, seed: Uint8Array) {
  shown++;
  mode = m;
  attract = null;
  sim.newGame(0, seed);
  ghostIdx = 0;
  ghostHeld = false;
  ghostDown = null;
  youTrail.length = 0;
  ghostTrail.length = 0;
  sparks.length = 0;
  pops.length = 0;
  lastGems = 0;
  passed = false;
  ahead = 0;
  shake = 0;
  if (m.kind === "race") sim.newGame(1, m.ghost.seed);
  if (m.kind === "watch") sim.newGame(0, m.ghost.seed);
  held = false;
  started = true;
  playing = false;
  // "3, 2, 1" the first time; a retry is back in the air in a second and a half.
  countdown = m.kind === "watch" ? 1 : Math.round((flown++ === 0 ? 3 : 1.5) * TICK_HZ);
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
  reveal();
  // A real run that starts in a hidden tab (the start landed while the player looked away) ends at
  // once, as one hidden mid-run does: the chain's clock is running.
  if ((m.kind === "race" || m.kind === "qualify") && m.real && mustEndNow(Infinity, document.hidden)) queueMicrotask(endNow); // after the start's own bookkeeping
}

const randomSeed = () => crypto.getRandomValues(new Uint8Array(32));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a: string) => esc(a.length > 22 ? `${a.slice(0, 19)}…` : a);
const txLink = (h = lastTx()) => (h ? ` <a href="${EXPLORER}/txns/${h}" target="_blank" rel="noopener">see the transaction</a>` : "");
/** A contract's note as a sentence (it has no full stop of its own), or nothing. */
const said = (note: string | null) => (note ? `${esc(note)}.` : "");
const msg = (e: unknown) => esc((e as Error)?.message ?? String(e));
/** What a failed start means for the player's money, in plain words. */
const nothingStaked = (e: unknown) => (/not final yet/.test(String((e as Error)?.message)) ? "It may still land: check the transaction before trying again." : "Nothing was staked: a refused call changes nothing.");

// ---------- ghosts' recorded runs: fetched once, replayed here ----------
const runs = new Map<string, Promise<GhostRun>>();
const flights = new Map<string, [number, number][]>();
const runKey = (g: Ghost) => `${g.id}:${g.log_hash}`;

function loadGhost(g: Ghost): Promise<GhostRun> {
  const k = runKey(g);
  let p = runs.get(k);
  if (!p) {
    p = (async () => {
      const cached = (() => {
        try {
          return JSON.parse(localStorage.getItem(`gd-log:${g.log_hash}`) ?? "null") as { seed: string; log: number[] } | null;
        } catch {
          return null;
        }
      })();
      const l = cached && cached.seed === g.seed ? cleanLog(cached) : await readGhostLog(g.id);
      if (l !== cached) {
        try {
          localStorage.setItem(`gd-log:${g.log_hash}`, JSON.stringify(l));
        } catch {
          /* a full or blocked store only costs a refetch */
        }
      }
      const r = { info: g, seed: unhex(l.seed), log: l.log };
      if (!flights.has(k)) flights.set(k, flightOf(r));
      return r;
    })();
    p.catch(() => runs.delete(k));
    runs.set(k, p);
  }
  // The board's numbers may be newer than the cached run's: keep the run, take the latest record.
  return p.then((r) => ({ ...r, info: g }));
}

/** A ghost's recorded flight as [tick, height] points: its log replayed on its seed. */
function flightOf(r: GhostRun): [number, number][] {
  liner.newGame(0, r.seed);
  let i = 0;
  let down = false;
  const pts: [number, number][] = [[0, liner.y(0)]];
  while (!liner.done(0)) {
    if (i < r.log.length && r.log[i] === liner.tick(0)) {
      down = !down;
      i++;
    }
    liner.step(0, down);
    if (liner.tick(0) % 10 === 0) pts.push([liner.tick(0), liner.y(0)]);
  }
  pts.push([liner.tick(0), liner.y(0)]);
  return pts;
}

const LANE_W = 360;
const LANE_H = 30;
/** The board's lane for a ghost: the track (a whole minute), its flight, and where it ended. Until
 *  its log arrives, a dotted line to where it crashed (from the ghost's own record). */
function lane(g: Ghost): string {
  const f = flights.get(runKey(g));
  const x = (t: number) => ((t / MAX_TICKS) * LANE_W).toFixed(1);
  const y = (v: number) => (3 + (v / VIEW_H) * (LANE_H - 6)).toFixed(1);
  const end = Math.max(3, (g.ticks / MAX_TICKS) * LANE_W);
  const ey = f ? Number(y(f[f.length - 1][1])) : LANE_H / 2;
  const line = f ? `<polyline class="flight" points="${f.map(([t, v]) => `${x(t)},${y(v)}`).join(" ")}"/>` : `<line class="guess" x1="0" y1="${LANE_H / 2}" x2="${end}" y2="${LANE_H / 2}"/>`;
  const crashed = g.ticks < MAX_TICKS;
  const mark = crashed ? `<path class="end" d="M${end - 3.5},${ey - 3.5}l7,7m0,-7l-7,7"/>` : `<rect class="flag" x="${end - 5}" y="${ey - 4}" width="5" height="8"/>`;
  const said = crashed ? `crashed after ${(g.ticks / TICK_HZ).toFixed(1)} of 60 seconds` : "flew the whole minute";
  return `<svg class="lane" viewBox="0 0 ${LANE_W} ${LANE_H}" role="img" aria-label="Ghost #${g.id}'s flight: ${said}"><line class="track" x1="0" y1="${LANE_H / 2}" x2="${LANE_W}" y2="${LANE_H / 2}"/>${line}${mark}</svg>`;
}

/** Fill in the board's flight lines, one ghost at a time (the public RPC rate-limits). */
let flightsGen = 0;
async function drawFlights() {
  const gen = ++flightsGen;
  const inView = Array.from(document.querySelectorAll<HTMLLIElement>(".ghosts li[data-id]")).filter((li) => {
    const r = li.getBoundingClientRect();
    return r.height > 0 && r.top < innerHeight + 300;
  });
  const todo = inView.map((li) => ghosts.find((g) => String(g.id) === li.dataset.id)).filter((g): g is Ghost => !!g && !flights.has(runKey(g)));
  for (const g of todo) {
    if (gen !== flightsGen) return;
    const fetched = !runs.has(runKey(g));
    try {
      await loadGhost(g);
    } catch {
      continue;
    }
    document.querySelectorAll(`.ghosts li[data-id="${g.id}"] .lane`).forEach((svg) => (svg.outerHTML = lane(g)));
    if (fetched) await new Promise((ok) => setTimeout(ok, 250));
  }
}
let scrolled = 0;
const lanesSoon = () => {
  clearTimeout(scrolled);
  scrolled = setTimeout(() => void drawFlights(), 300);
};
addEventListener("scroll", lanesSoon, { passive: true });
addEventListener("resize", lanesSoon);

/** Race a ghost: for real if you may (a duel that names you, or the public ladder), else a free
 *  practice race against its recorded flight on a cave this page draws. */
async function race(g: Ghost, agreed = false) {
  const real = !!me && canRace(g, me.id);
  if (blocked(!real)) return;
  reveal();
  const noGhost = (e: unknown) => show(`<p class="big lose">NO GHOST</p><p class="err">Couldn't load ghost #${g.id}'s recorded run: ${msg(e)}</p><p class="small">NEAR testnet's public servers may be busy. Try again in a moment, or practise meanwhile.</p>`, [["Practice", () => begin({ kind: "practice" }, randomSeed()), true], ["Back", title]]);
  if (!real || !me) {
    const seq = shown;
    const ghost = await loadGhost(g).catch((e) => void (shown === seq && noGhost(e)));
    if (ghost && shown === seq) begin({ kind: "race", ghost, real: null }, randomSeed());
    return;
  }
  // A real race: from the click on, the card says what is happening and nothing else can start.
  const duel = ghostKind(g) === "duel";
  leaveFreeRun();
  waiting = true;
  show(busy(duel
    ? `Locking your ${near(g.stake)} NEAR stake against ghost #${g.id}'s ${near(g.pot)} NEAR pot. Your cave is drawn now; nobody has seen it.`
    : `Ghost #${g.id} is on the public ladder: nothing is staked. Your cave is drawn now, and the contract will replay your flight.`), [], "busy");
  try {
    let ghost: GhostRun;
    try {
      ghost = await loadGhost(g);
    } catch (e) {
      return void noGhost(e);
    }
    // The pot is the one term of a duel that can change after the board was read (won, then
    // refilled smaller). Read it again now, and never stake for a smaller pot without asking; the
    // start itself carries the pot shown here as `min_pot` (v5 refuses a smaller one).
    if (duel && !agreed) {
      const fresh = await readGhost(g.id).catch(() => null);
      if (fresh && fresh.id === g.id && BigInt(fresh.pot) < BigInt(g.pot)) {
        ghosts = ghosts.map((x) => (x.id === fresh.id ? fresh : x));
        if (!canRace(fresh, me.id)) return void show(`<p class="big lose">NOT OPEN</p><p class="lead">Ghost #${g.id}'s pot was ${near(g.pot)} NEAR when the board was read; it is ${near(fresh.pot)} now, so it can't be raced until its owner refills it.</p><p class="small">Nothing was staked.</p>`, [["Back", title]]);
        return void show(`<p class="big">THE POT CHANGED</p><p class="lead">Ghost #${g.id}'s pot was <b>${near(g.pot)} NEAR</b> when the board was read. It is <b>${near(fresh.pot)} NEAR</b> now; your stake would still be ${near(fresh.stake)} NEAR.</p><p class="small">Nothing was staked.</p>`,
          [[`Race for ${near(fresh.pot)} NEAR`, () => race(fresh, true), true], ["Back", title]]);
      }
    }
    const run = (await callRun(me.session, "start_run", startArgs(g.id, cfg, g.pot), 50n))!;
    startedLocal = Date.now();
    begin({ kind: "race", ghost, real: run }, unhex(run.seed));
  } catch (e) {
    show(`<p class="big lose">NOT STARTED</p><p class="err">The contract refused: ${msg(e)}</p><p class="small">${nothingStaked(e)}</p>`, [["Back", title]]);
  } finally {
    waiting = false;
  }
}

/** Fly a qualifier: the form, then start_run({qualify}). A duel names who may race it and is signed
 *  with the guest's full-access key (1 yoctoNEAR); the ladder's is the session key's. */
function flyForm(prefill = "", duel = prefill !== "") {
  if (blocked()) return;
  leaveFreeRun();
  if (!me?.full) return show(`<p class="lead">Flying for a ghost needs a test account of your own: press Play for real first.</p>`, [...(!me ? [["Play for real", () => void playForReal(), true] as Btn] : []), ["Back", title]]);
  show(`<p class="big">FLY FOR A GHOST</p>
    <p class="small">Fly a run of your own. Score 100 or more and it becomes a ghost on the board, for others to race.</p>
    <div class="form">
      <div class="choice" role="radiogroup" aria-label="Who may race it">
        <label><input type="radio" name="kind" value="ladder" ${duel ? "" : "checked"}><span><b>Public ladder</b> Anyone may race it. Nothing is staked.</span></label>
        <label><input type="radio" name="kind" value="duel" ${duel ? "checked" : ""}><span><b>Private duel</b> Only the players you name may race it, for a pot.</span></label>
      </div>
      <div id="duel-terms" class="terms" ${duel ? "" : "hidden"}>
        <label>Who may race it: their account ids, comma separated <input id="f-names" value="${esc(prefill)}" placeholder="gd-xxxx.testnet" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div class="pair"><label>Pot, in NEAR <input id="f-pot" value="0.2" inputmode="decimal"></label><label>Stake per race <input id="f-stake" value="0.05" inputmode="decimal"></label></div>
        <p class="small muted">The pot is locked before your cave exists; a run under 100 points gives it back minus 20%. A challenger who beats your score takes the pot; one who falls short pays you 70% of the stake (25% grows the pot, 5% goes to the house).</p>
      </div>
      <p id="f-err" class="err" role="alert"></p>
    </div>`, [["Fly", () => void flyQualifier(), true], ["Back", title]]);
  overlay.querySelectorAll<HTMLInputElement>('input[name="kind"]').forEach((r) => r.addEventListener("change", () => ($("duel-terms").hidden = r.value !== "duel" || !r.checked)));
}

let flying = false;
async function flyQualifier() {
  if (flying || blocked()) return;
  const seq = shown;
  const kind = (document.querySelector('input[name="kind"]:checked') as HTMLInputElement | null)?.value === "duel" ? "duel" : "ladder";
  const val = (id: string) => ($(id) as HTMLInputElement | null)?.value ?? "";
  let q;
  try {
    q = qualifyArgs(kind, me!.id, val("f-pot"), val("f-stake"), val("f-names"), cfg, yocto);
  } catch (e) {
    $("f-err").textContent = (e as Error).message;
    return;
  }
  // The balance must be able to finish the run (rules.ts `qualifierShortfall` says why). If it
  // can't be read, the contract still refuses a start it can't cover.
  flying = true;
  const have = await view<string>("get_balance", { account_id: me!.id }).then(BigInt, () => null).finally(() => (flying = false));
  if (shown !== seq) return; // Back was pressed meanwhile
  const short = have === null ? null : qualifierShortfall(have, BigInt((q.args.qualify as { pot: string }).pot), (y) => near(y), LIVE_VERSION);
  if (short) return void ($("f-err").textContent = short);
  waiting = true;
  show(busy(kind === "duel" ? "Locking your pot. Your cave is drawn now; nobody has seen it." : "Your cave is drawn now; nobody has seen it."), [], "busy");
  try {
    const run = (await callRun(kind === "duel" ? me!.full! : me!.session, "start_run", q.args, 50n, q.deposit))!;
    startedLocal = Date.now();
    begin({ kind: "qualify", real: run, duel: kind === "duel" }, unhex(run.seed));
  } catch (e) {
    show(`<p class="big lose">NOT STARTED</p><p class="err">The contract refused: ${msg(e)}</p><p class="small">${nothingStaked(e)}</p>`, [["Back", title]]);
  } finally {
    waiting = false;
  }
}

async function submitReal(run: Run, log: number[], score: number): Promise<Run> {
  const r = await callRun(me!.session, "submit_run", { run_id: run.id, log, claimed_score: score }, 100n);
  return r ?? (await readRun(run.id));
}

async function copy(s: string, what: string) {
  try {
    await navigator.clipboard.writeText(s);
    status(`Copied ${what}.`);
  } catch {
    status(s);
  }
}

async function finish() {
  playing = false;
  held = false;
  const seq = shown;
  if (mode.kind === "watch") {
    const g = mode.ghost;
    const ok = sim.score(0) === g.info.score && (await sha256(logBytes(g.log))) === g.info.log_hash;
    if (shown !== seq) return; // another run began meanwhile
    show(`<p class="eyebrow">Replayed in this browser</p><p class="big">GHOST #${g.info.id}</p><p>This page re-flew its ${g.log.length} recorded button changes on its cave:
      <span class="ghostscore">${sim.score(0)}</span> points.</p><p class="${ok ? "settled" : "err"}">${ok ? "✓ the same score the contract recorded, and the log matches its on-chain hash." : "✗ this does not match the chain."}</p>`,
      [["Race it", () => race(g.info), true], ["Back", title]]);
    return;
  }
  if (!sim.alive(0)) {
    burst(SHIP_X, sim.y(0), C.you);
    fx.crashes++;
    sound.crash();
    if (!still) shake = 16;
  }
  const score = sim.score(0);
  const log = sim.log(0);
  const real = mode.kind === "race" || mode.kind === "qualify" ? mode.real : null;
  // A real run's submit is pending from here: nothing else starts until it lands.
  if (real) waiting = true;
  try {
    await settle(seq, score, log, real);
  } finally {
    if (real) waiting = false;
  }
}

async function settle(seq: number, score: number, log: number[], real: Run | null) {
  const lh = await sha256(logBytes(log));
  if (shown !== seq) return; // another run began meanwhile
  $("payload").textContent = JSON.stringify({ method: "submit_run", run_id: real ? real.id : "(from start_run)", claimed_score: score, log: `[${log.length} ticks]`, log_hash: lh }, null, 1);
  if (mode.kind === "qualify") {
    const { real: run, duel } = mode;
    show(`<p class="big">${score} POINTS</p>${busy(`Sending your ${log.length} button changes. The contract replays them itself; this page's score doesn't count.`)}`, [], "busy");
    try {
      const r = await submitReal(run, log, score);
      const minted = r.status === "Minted" && r.minted;
      const link = minted && duel ? inviteLink(location.href, CONTRACT, r.minted!, V4) : "";
      show(`<p class="big ${minted ? "win" : "lose"}">${minted ? `GHOST #${r.minted}` : "NO GHOST"}</p><p class="settled">${said(r.note)}${txLink()}</p>
        ${minted && duel ? `<p class="lead">Send your challengers this link. When they open it, they can race it for the pot.</p><input class="link" readonly value="${esc(link)}" aria-label="Invite link" onfocus="this.select()">` : minted ? `<p class="muted">It's on the public ladder: anyone may race it, and no money moves.</p>` : ""}`,
        [...(minted && duel ? [["Copy invite link", () => void copy(link, "the invite link"), true] as Btn] : []), ["Fly again", () => flyForm(), !(minted && duel)], ["Back", title]]);
      void refresh();
    } catch (e) {
      show(`<p class="big lose">NOT SETTLED</p><p class="err">${msg(e)}</p>`, [["Back", title]]);
    }
    return;
  }
  if (mode.kind === "race") {
    const info = mode.ghost.info;
    const beat = score > info.score;
    const sp = splitOf(info.stake);
    const ladder = ghostKind(info) === "ladder";
    const verdict = `<p class="big ${beat ? "win" : "lose"}">${beat ? "YOU BEAT THE GHOST" : "THE GHOST HOLDS"}</p>
      <div class="vs"><span class="score">${score}</span><span class="v">vs</span><span class="ghostscore">${info.score}</span><small>ghost #${info.id}</small></div>`;
    const would = mode.real ? "" : " (had this been staked)";
    const stakes = ladder
      ? `<p class="money">The public ladder: nothing at stake.</p>`
      : beat
        ? `<p class="money win">+${near(info.pot)} NEAR: the ghost's whole pot${would}</p>`
        : `<p class="money lose">−${near(info.stake)} NEAR${would}: ${sp.owner.toFixed(3)} to its owner, ${sp.pot.toFixed(3)} into its pot, ${sp.house.toFixed(3)} to the house</p>`;
    if (mode.real) {
      const run = mode.real;
      show(`${verdict}${busy(`Sending your ${log.length} button changes. The contract replays them itself and pays out; this page's score doesn't count.`)}`, [], "busy");
      try {
        const settled = await submitReal(run, log, score);
        show(`${verdict}${stakes}<p class="settled">Paid out: <b>${esc(settled.status)}</b>. ${said(settled.note)}${txLink()}</p><p class="via">${esc(settled.replay?.via ?? "")}</p>`,
          [["Race again", () => race(info), true], ["Back", title]]);
        void refresh();
      } catch (e) {
        show(`${verdict}<p class="err">Not settled: ${msg(e)}</p>`, [["Back", title]]);
      }
    } else {
      show(`${verdict}${earlyTip(score)}${stakes}<p class="small muted">A free practice race against the real ghost, on a cave this page drew. ${!me ? "Play for real and the same race is settled by the contract." : info.owner === me.id ? "It's your own ghost." : ghostState(info).open ? "Only the players its owner named race this duel for real." : `It can't be raced for real now: ${ghostState(info).label}.`}</p>`,
        [["Race again", () => race(info), true], ...(!me ? [["Play for real", () => void playForReal()] as Btn] : []), ["Back", title]]);
    }
    return;
  }
  const f = featured();
  show(`<p class="big ${sim.alive(0) ? "win" : ""}">${sim.alive(0) ? "SURVIVED" : "CRASHED"}</p><p class="lead"><span class="score">${score}</span> points · ${sim.metres(0)} m · ${sim.gems(0)} gems</p>${earlyTip(score)}${f ? `<p class="hint">Now race a ghost: #${f.id} flew <span class="ghostscore">${f.score}</span>.</p>` : ""}`,
    [...(f ? [[`Race ghost #${f.id}`, () => race(f), true] as Btn] : []), ["Fly again", () => begin({ kind: "practice" }, randomSeed()), !f], ["Back", title]]);
}

/** A run that ended almost at once: say how the button works, where it is needed. */
const earlyTip = (score: number) => (!sim.alive(0) && score < 40 ? `<p class="hint you">Hold as the count ends, then tap in short bursts to hover: holding climbs, letting go falls.</p>` : "");

/** The ghost to race first: a duel that names you; else the most beatable on the public ladder;
 *  else (no guest) any open ghost, as a practice race. */
function featured(): Ghost | undefined {
  const byScore = (a: Ghost, b: Ghost) => a.score - b.score;
  const mine = me?.id ?? null;
  const duels = ghosts.filter((g) => ghostKind(g) === "duel" && canRace(g, mine)).sort(byScore);
  const ladder = ghosts.filter((g) => ghostKind(g) === "ladder" && canRace(g, mine)).sort(byScore);
  return duels[0] ?? ladder[0] ?? (mine ? undefined : ghosts.filter((g) => ghostState(g).open).sort(byScore)[0]);
}

/** #duel=N: a link a ghost's owner sent. */
const invited = () => Number(new URLSearchParams(location.hash.slice(1)).get("duel")) || null;
addEventListener("hashchange", () => {
  const at = shown;
  void refresh().then(() => retitle(at));
});

/** After a board read: redraw the title if it is still on screen, or if nothing has replaced the
 *  screen that was showing at `since` (a link opened over a result card or the Fly form takes it).
 *  Never over a run or a pending card (`title`). */
function retitle(since = -1) {
  if (overlay.className === "title" || shown === since) title(true);
}

function title(redraw = false) {
  // Never over a run or its pending card (a start, a submit): a board read that began before it (a
  // link's fragment changed, a guest was being made, a slow RPC) ends here, and the run keeps the
  // screen. An owner's pending transaction is in "You", not on this screen.
  if (playing || countdown > 0 || overlay.className === "busy") return;
  const mine = me?.id ?? null;
  const id = invited();
  const inv = id ? ghosts.find((g) => g.id === id) : undefined;
  const invDuel = !!inv && ghostKind(inv) === "duel";
  const asked = !!(inv && invDuel && canRace(inv, mine));
  // An invite to a public-ladder ghost is just that ghost to race.
  const target = asked || (inv && !invDuel && inv.owner !== mine) ? inv : featured();
  const real = !!(target && canRace(target, mine) && mine);
  let head = "Race a ghost";
  let hint: string;
  if (asked && inv) {
    head = "You're invited";
    hint = `<p class="hint you"><b>${short(inv.owner)}</b>'s ghost #${inv.id} flew <span class="ghostscore">${inv.score}</span>. Beat it and its <b>${near(inv.pot)} NEAR</b> pot is yours; fall short and it keeps your ${near(inv.stake)} NEAR stake.</p>`;
  } else if (inv && invDuel) {
    head = `A duel: ghost #${inv.id}`;
    hint = inv.owner === mine
      ? `<p class="hint">Ghost #${inv.id} is your own duel: send this link to the players you named.</p>`
      : !ghostState(inv).open
        ? `<p class="hint">Ghost #${inv.id}'s duel is closed: ${ghostState(inv).label}.</p>`
        : `<p class="hint">Only the players its owner named may race ghost #${inv.id} for its pot. ${me ? `Send ${short(inv.owner)} your account id, <b>${esc(me.id)}</b>, then open the link again.` : "Press Play for real, send its owner your account id, then open the link again."}</p>`;
  } else if (id && !inv && board === "ok") hint = `<p class="hint">There's no ghost #${id} on the board.</p>`;
  else if (target && real && ghostKind(target) === "duel") {
    hint = `<p class="hint you">Ghost #${target.id}, a duel from ${short(target.owner)}, flew <span class="ghostscore">${target.score}</span>. Beat it and its <b>${near(target.pot)} NEAR</b> pot is yours; fall short and it keeps your ${near(target.stake)} NEAR.</p>`;
  } else if (target && real) {
    hint = `<p class="hint">Ghost #${target.id} on the public ladder flew <span class="ghostscore">${target.score}</span>. Race it for real: the contract replays your flight and records it. Nothing is staked.</p>`;
  } else if (target) {
    hint = `<p class="hint">Ghost #${target.id} flew <span class="ghostscore">${target.score}</span>. Race it now, free: nothing to sign up for, nothing at stake.</p>`;
  } else if (board === "error") hint = `<p class="hint">The board can't be reached right now, so there's no ghost to race. Practice works without it.</p>`;
  else if (board === "loading") hint = `<p class="hint muted">${busy("Loading the ghosts…")}</p>`;
  else hint = `<p class="hint">${ghosts.length ? "No ghost is open to you right now" : "No ghosts yet"}: practise, or fly one of your own.</p>`;
  show(`<p class="big">${head}</p>
    <p class="lead phone-hide">A ghost is a run somebody flew in a cave of its own. You get a fresh cave; the ghost flies beside you at the pace it flew. Score more than it did to beat it.</p>${hint}
    <p class="small muted">Hold <kbd>Space</kbd>, click or touch to climb; let go to fall. Gems are worth 25.</p>`,
    [...(target ? [[`Race ghost #${target.id}`, () => race(target), true] as Btn] : []), ["Practice", () => begin({ kind: "practice" }, randomSeed()), !target],
      ...(me?.full ? [["Fly for a ghost", () => flyForm()] as Btn] : !me ? [["Play for real", () => void playForReal()] as Btn] : [])], "title", redraw);
  // The screen behind the title flies the ghost on offer (its recorded run), once it's loaded.
  if (!attract || (target && attract.ghost?.info.id !== target.id)) {
    if (!attract) attractStart(null);
    if (target) void loadGhost(target).then((r) => attract && attract.ghost?.info.id !== r.info.id && attractStart(r), () => {});
  }
}

// ---------- you: the guest ----------

/** The line under "You": progress (with the waiting dots), a result, or what went wrong. */
function status(line: string, kind: "" | "busy" | "bad" = "", tx: string | null = null) {
  const el = $("you-status");
  el.className = kind === "bad" ? "bad" : "";
  el.innerHTML = `${kind === "busy" ? `<span class="wait" aria-hidden="true"><i></i><i></i><i></i></span>` : ""}${esc(line)}${tx ? txLink(tx) : ""}`;
}

let joining = false;
async function playForReal() {
  if (me) return title(); // a card from before the guest was made
  if (joining) return;
  joining = true;
  const at = shown;
  renderYou();
  $("you-box").scrollIntoView({ block: "nearest" });
  try {
    const g = await makeGuest((line) => status(line, "busy"));
    me = asPlayer(g);
    status(`Ready: you're ${g.id}. Races are real now.`);
    joining = false;
    await refresh();
    retitle(at);
  } catch (e) {
    status(`Couldn't make your test account: ${(e as Error).message.replace(/[^.]$/, "$&.")} Practice and the free races still work.`, "bad");
  } finally {
    joining = false;
    renderYou();
  }
}

function renderYou() {
  const box = $("you");
  box.innerHTML = "";
  const p = document.createElement("p");
  const row = document.createElement("div");
  row.className = "row";
  const btn = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.onclick = fn;
    row.append(b);
    return b;
  };
  if (!me) {
    const half = pendingGuest();
    p.innerHTML = `<b>Practice is free.</b> Play for real makes you a test account on NEAR's test network, with free test money in it: no sign-up, and its keys stay in this browser.`;
    const b = btn(joining ? "Setting up…" : half ? `Finish setting up ${half}` : "Play for real", () => void playForReal(), true);
    b.disabled = joining;
  } else {
    // The last amounts read stay on screen while they are read again (a busy public RPC must not
    // turn them back into dots); see `readMoney`.
    const m = money?.id === me.id ? money : null;
    p.innerHTML = `Playing as <b>${esc(me.id)}</b>. Your races are settled by the contract, with no pop-ups. In the game: <b id="bal">${m?.bal ?? "…"}</b> NEAR${me.sessionPk ? ` · this page's game key can still put <span id="cap">${m?.cap ?? "…"}</span> NEAR at risk` : ""}.`;
    btn("Copy my account id", () => void copy(me!.id, `${me!.id}: send it to whoever should name you in a duel`));
    if (me.full) {
      btn("Fly for a ghost", () => flyForm(), true);
      btn("Cash out…", () => void cashOutFlow());
      btn("Forget this guest", () =>
        inlineForm($("you"), { label: `Forget ${me!.id}? Its keys are only in this browser: what's in it is lost unless you cash out first.`, action: "Forget it", confirmOnly: true }, () => {
          if (blocked()) return;
          forgetGuest();
          me = null;
          status("");
          renderYou();
          void refresh().then(() => retitle());
        }));
    }
    void readMoney(me);
  }
  box.append(p, row);
}

/** The guest's in-game balance and what its game key may still risk, as last read. */
let money: { id: string; bal: string | null; cap: string | null } | null = null;
let moneyRead = 0;
/** Read both (three tries each, a little apart: the public RPC rate-limits) and show them. Only
 *  the newest read writes, and a failed read leaves the last amounts where they are. */
async function readMoney(who: Player) {
  const mine = ++moneyRead;
  if (money?.id !== who.id) money = { id: who.id, bal: null, cap: null };
  const m = money;
  const tries = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
    for (let i = 0; i < 3; i++) {
      try {
        return await f();
      } catch {
        await new Promise((ok) => setTimeout(ok, 600 * (i + 1)));
      }
    }
    return undefined;
  };
  const b = await tries(() => view<string>("get_balance", { account_id: who.id }));
  if (b !== undefined) m.bal = near(b);
  if (who.sessionPk) {
    const k = await tries(() => view<{ cap: string; spent: string } | null>("get_key_cap", { account_id: who.id, public_key: who.sessionPk! }));
    if (k) m.cap = near(BigInt(k.cap) > BigInt(k.spent) ? BigInt(k.cap) - BigInt(k.spent) : 0n);
  }
  if (mine !== moneyRead || me?.id !== who.id) return;
  const [balEl, capEl] = [document.getElementById("bal"), document.getElementById("cap")];
  if (balEl && m.bal) balEl.textContent = m.bal;
  if (capEl && m.cap) capEl.textContent = m.cap;
}

/** A one-field form in the page (not a browser prompt): a label, an input, OK and Cancel. Enter
 *  submits, Escape cancels. `host` holds at most one; `ok` gets the trimmed value. */
function inlineForm(host: HTMLElement, o: { label: string; value?: string; placeholder?: string; action: string; allowEmpty?: boolean; confirmOnly?: boolean }, ok: (v: string) => void) {
  host.querySelector("form.inline")?.remove();
  const f = document.createElement("form");
  f.className = "inline";
  const id = `in-${Math.random().toString(36).slice(2, 8)}`;
  f.innerHTML = `<label for="${id}">${esc(o.label)}</label><input id="${id}" value="${esc(o.value ?? "")}" placeholder="${esc(o.placeholder ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="row"><button type="submit" class="primary">${esc(o.action)}</button><button type="button">Cancel</button></div>`;
  const input = f.querySelector("input")!;
  // A yes/no question: the same form without its field.
  if (o.confirmOnly) input.hidden = true;
  const close = () => {
    f.remove();
    if (boardLate) drawBoard();
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v && !o.allowEmpty && !o.confirmOnly) return input.focus();
    close();
    ok(v);
  };
  f.querySelector<HTMLButtonElement>('button[type="button"]')!.onclick = close;
  f.onkeydown = (e) => e.key === "Escape" && close();
  host.append(f);
  (o.confirmOnly ? f.querySelector<HTMLButtonElement>('button[type="button"]')! : input).focus({ preventScroll: true });
  f.scrollIntoView({ block: "nearest" });
}

function cashOutFlow() {
  inlineForm($("you"), { label: "Cash out: everything in this guest (its in-game balance and its account) goes to the account you name here, and the guest is closed.", placeholder: "your-account.testnet", action: "Cash out and close" }, (to) => void cashOutTo(to));
}

async function cashOutTo(to: string) {
  if (blocked() || !me?.full) return;
  waiting = true;
  try {
    const h = await cashOut({ id: me.id, full: me.full, session: me.session, sessionPk: me.sessionPk ?? "" }, to.toLowerCase(), (line) => status(line, "busy"));
    status(`Done: ${me.id} is closed and everything went to ${to.toLowerCase()}.`, "", h);
    me = null;
    renderYou();
  } catch (e) {
    return status(`Cash out failed: ${(e as Error).message}`, "bad");
  } finally {
    waiting = false;
  }
  void refresh().then(() => retitle());
}

// ---------- the board ----------

/** Your own ghost: refill, retire, give away, change who may race it (full-access key). */
async function ownerAction(label: string, f: () => Promise<unknown>) {
  if (blocked()) return;
  waiting = true;
  try {
    status(`${label}…`, "busy");
    await f();
    status(`${label}: done.`, "", lastTx());
  } catch (e) {
    return status(`${label}: the contract refused: ${(e as Error).message}`, "bad");
  } finally {
    waiting = false;
  }
  await refresh();
}

type Act = [string, (li: HTMLLIElement) => void];
function ownerButtons(g: Ghost): Act[] {
  if (!me?.full || g.owner !== me.id) return [];
  const full = me.full;
  const acts: Act[] = [];
  if (ghostKind(g) === "duel") {
    acts.push(["Invite link", () => void copy(inviteLink(location.href, CONTRACT, g.id, V4), `the invite link to ghost #${g.id}`)]);
    acts.push(["Challengers…", (li) => inlineForm(li, { label: `Who may race ghost #${g.id}: account ids, comma separated. Leave it empty to close the duel.`, value: g.challengers.join(", "), placeholder: "gd-xxxx.testnet", action: "Save the list", allowEmpty: true }, (v) => {
      const list = [...new Set(v.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
      void ownerAction(list.length ? `Naming ${list.length} challengers for ghost #${g.id}` : `Closing ghost #${g.id} (naming nobody)`, () => callGame(full, "set_challengers", { ghost_id: g.id, challengers: list }, 30n, 1n));
    })]);
    const room = BigInt(g.qualified_pot) - (BigInt(g.pot) - BigInt(g.grown_in_pot));
    if (room > 0n) acts.push([`Refill ${near(room)}`, () => void ownerAction(`Refilling ghost #${g.id}`, () => callGame(full, "refill_ghost", { ghost_id: g.id, amount: room.toString() }, 30n, 1n))]);
    if (BigInt(g.pot) > 0n) acts.push(["Retire", () => void ownerAction(`Retiring ghost #${g.id}${Date.now() < g.pot_locked_until_ms ? ` (its pot is locked until ${new Date(g.pot_locked_until_ms).toLocaleString()})` : ""}`, () => callGame(full, "retire_ghost", { ghost_id: g.id }, 30n))]);
  }
  acts.push(["Give…", (li) => inlineForm(li, { label: `Give ghost #${g.id}, with its pot and what it earns from now on, to this account:`, placeholder: "their-account.testnet", action: "Give it away" }, (to) => {
    void ownerAction(`Giving ghost #${g.id} to ${to}`, () => callGame(full, "nft_transfer", { receiver_id: to.toLowerCase(), token_id: String(g.id) }, 30n, 1n));
  })]);
  return acts;
}

function item(g: Ghost): HTMLLIElement {
  const li = document.createElement("li");
  const st = ghostState(g);
  const duel = ghostKind(g) === "duel";
  const mine = me !== null && g.owner === me.id;
  li.className = `${duel ? "duel" : "ladder"}${st.open ? "" : " closed"}${mine ? " mine" : ""}`;
  li.dataset.id = String(g.id);
  const terms = duel ? (!st.open ? st.label : `<span class="pot">pot ${near(g.pot)} NEAR</span> · stake ${near(g.stake)}${g.racing ? ` · ${st.label}` : ""}`) : `public ladder${g.racing ? ` · ${st.label}` : ""}`;
  const who = mine ? (duel ? `yours · names ${g.challengers.length === 1 ? short(g.challengers[0]) : `${g.challengers.length} players`}` : "yours") : duel ? `<b>${short(g.owner)}</b> names ${g.challengers.length === 1 ? short(g.challengers[0]) : `${g.challengers.length} players`}` : `<b>${short(g.owner)}</b>`;
  const record = `defended ${g.defended}${g.defended ? ` (best losing ${g.best_challenge})` : ""} · beaten ${g.beaten}${g.forfeits ? ` · forfeits ${g.forfeits}` : ""}${duel && BigInt(g.earned) > 0n ? ` · earned ${near(g.earned)}` : ""}${duel && BigInt(g.grown) > 0n ? ` · pot grew ${near(g.grown)}` : ""}`;
  li.innerHTML = `<b class="plate">#${g.id}</b> <span class="who">${who}</span> <span class="r-score">${g.score}<small>pts</small></span>
    ${lane(g)}
    <div class="r-meta">${duel || g.racing ? `${terms}<br>` : ""}${record}</div><div class="row"></div>`;
  const row = li.querySelector(".row")!;
  const real = me !== null && canRace(g, me.id);
  const raceLabel = real ? (duel ? `Race for ${near(g.pot)} NEAR` : "Race (on chain, free)") : st.open && g.owner !== me?.id ? "Practice race" : null;
  const acts: Act[] = [...(raceLabel ? [[raceLabel, () => void race(g)] as Act] : []), ["Watch", async () => {
    if (blocked(true)) return;
    const seq = shown;
    try {
      const ghost = await loadGhost(g);
      if (shown === seq) begin({ kind: "watch", ghost }, new Uint8Array(32));
    } catch (e) {
      status(`Couldn't load ghost #${g.id}'s recorded run: ${(e as Error).message}`, "bad");
    }
  }], ...ownerButtons(g)];
  for (const [label, fn] of acts) {
    const b = document.createElement("button");
    b.textContent = label;
    if (real && label === raceLabel) b.className = "primary";
    b.onclick = () => fn(li);
    row.append(b);
  }
  return li;
}

/** Read the board. Reads can overlap (a link opened, a race settled): only the newest one draws. */
let reads = 0;
async function refresh() {
  const read = ++reads;
  try {
    const c = await view<{ replay_fee: string }>("get_config");
    const list = await readGhosts();
    // A duel someone was invited to is read by its id too, however long the board has grown.
    const inv = invited();
    if (inv && !list.some((g) => g.id === inv)) {
      const g = await readGhost(inv).catch(() => null);
      if (g && g.id === inv) list.push(g);
    }
    if (read !== reads) return;
    cfg = c;
    ghosts = list;
    board = "ok";
    drawBoard();
  } catch (e) {
    if (read !== reads) return;
    board = "error";
    const box = $("lists");
    if (!ghosts.length) {
      box.innerHTML = `<p class="board-note bad">Can't reach NEAR testnet right now, so the board is empty. Practice still works.</p>`;
      const b = document.createElement("button");
      b.textContent = "Try again";
      b.onclick = () => {
        $("net").textContent = "Reading the board…";
        void refresh().then(() => retitle());
      };
      box.append(b);
    }
    $("net").textContent = `couldn't read ${CONTRACT}: ${(e as Error).message}`;
  }
}

/** A board read that lands while the player is typing in a form (Cash out…, Give…) waits for the
 *  form to close: redrawing would wipe it. */
let boardLate = false;
const openShowMore = new Set<string>();
function drawBoard() {
  if (document.querySelector("form.inline")) return void (boardLate = true);
  boardLate = false;
  const duels = ghosts.filter((g) => ghostKind(g) === "duel");
  $("net").innerHTML = `${CONTRACT === V4 ? "" : `<b class="bad">This link points the page at another contract, not the game's own (${V4}).</b> `}<a href="${EXPLORER}/address/${CONTRACT}">${CONTRACT}</a> · ${ghosts.length} ghosts: ${duels.length} private duels, ${ghosts.length - duels.length} on the public ladder`;
  const mine = me?.id ?? null;
  const groups: [string, Ghost[]][] = [
    ["Duels you're named in", duels.filter((g) => mine && g.challengers.includes(mine) && g.owner !== mine)],
    ["Your ghosts", ghosts.filter((g) => mine && g.owner === mine)],
    ["The public ladder (anyone may race; no money moves)", ghosts.filter((g) => ghostKind(g) === "ladder" && g.owner !== mine)],
    ["Other players' duels (watch, or practice against them)", duels.filter((g) => g.owner !== mine && !(mine && g.challengers.includes(mine)))],
  ];
  const box = $("lists");
  box.innerHTML = "";
  for (const [i, [name, list]] of groups.entries()) {
    if (!list.length) continue;
    const h = document.createElement("h3");
    const cut = name.indexOf(" (");
    h.textContent = cut < 0 ? name : name.slice(0, cut);
    if (cut >= 0) h.append(Object.assign(document.createElement("span"), { textContent: name.slice(cut) }));
    const ol = document.createElement("ol");
    ol.className = "ghosts";
    // Open ghosts first, then the best run on top: a race board. Other players' duels show five,
    // the rest behind a button.
    list.sort((a, b) => Number(ghostState(b).open) - Number(ghostState(a).open) || b.score - a.score).forEach((g, k) => {
      const li = item(g);
      if (i >= 2 && k >= 5 && list.length > 6) li.classList.add("more");
      ol.append(li);
    });
    box.append(h, ol);
    // A list opened with "Show N more" stays open when the board is read again.
    if (openShowMore.has(name)) ol.classList.add("open");
    else if (ol.querySelector(".more")) {
      const more = document.createElement("button");
      more.className = "show-more";
      more.textContent = `Show ${list.length - 5} more`;
      more.onclick = () => {
        openShowMore.add(name);
        ol.classList.add("open");
        more.remove();
        void drawFlights();
      };
      box.append(more);
    }
  }
  if (!ghosts.length) box.innerHTML = `<p class="board-note">No ghosts yet. Play for real and fly the first one.</p>`;
  if (me) renderYou();
  void drawFlights();
}

// Read-only hook for the page test and the demo recorder (demo/page-test.ts, demo/record.ts): what
// the sim says, nothing it can change. `ahead` is the middle of the cave 60 px in front of the ship,
// as drawn: what a player sees.
(globalThis as { __gd?: unknown }).__gd = () => {
  if (!started) return null;
  const c = sim.col(0, Math.floor((sim.cam(0) + SHIP_X + 60) / COL_W));
  return { mode: mode.kind, tick: sim.tick(0), score: sim.score(0), done: sim.done(0), playing, countdown, y: sim.y(0), vy: sim.vy(0), ahead: c ? (c.top + c.bot) / 2 : null, gems: sim.gems(0), fx: { ...fx } };
};
// Likewise read-only: whether sound may play yet (no AudioContext before the first input).
(globalThis as { __gdSound?: unknown }).__gdSound = () => sound.soundState();

// The loop starts first: the game never waits on the network (a slow or failed RPC only leaves
// the board empty; Practice still plays).
// v4's limit (a ghost's owner can take the pot first, 0022) is said on the page only while v4 is
// the live contract; v5 refuses it (0023).
if (LIVE_VERSION !== "v4") document.getElementById("duel-caveat")?.remove();
const hood = $<HTMLAnchorElement>("hood-contract");
hood.href = `${EXPLORER}/address/${CONTRACT}`;
hood.textContent = CONTRACT;
document.querySelectorAll<HTMLAnchorElement>('a[href="#hood"]').forEach((a) => a.addEventListener("click", () => (($("hood") as HTMLDetailsElement).open = true)));
$("lists").innerHTML = `<ol class="ghosts skeleton" aria-hidden="true"><li></li><li></li><li></li></ol>`;
renderYou();
title();
requestAnimationFrame(frame);
await refresh();
retitle();
