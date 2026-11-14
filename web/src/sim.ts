// Loads the browser build of the simulation (res/ghost_sim_web.wasm) and wraps its C-ABI exports.
// The same file runs in the browser (the game) and in Node (demo/killtest.ts, the runner's checks),
// so the kill test exercises exactly what players run.
export type Column = { top: number; bot: number; gem: number | null };

type Exports = {
  memory: WebAssembly.Memory;
  gd_buf(): number;
  gd_new(slot: number): void;
  gd_step(slot: number, held: number): number;
  gd_tick(slot: number): number;
  gd_y(slot: number): number;
  gd_vy(slot: number): number;
  gd_dist(slot: number): number;
  gd_gems(slot: number): number;
  gd_alive(slot: number): number;
  gd_done(slot: number): number;
  gd_score(slot: number): number;
  gd_metres(slot: number): number;
  gd_col(slot: number, k: number): number;
  gd_cols(): number;
  gd_log(slot: number): number;
  gd_state(slot: number): number;
  gd_replay(slot: number, n: number): number;
};

export const FP = 256;
export const MAX_TICKS = 3600;
export const TICK_HZ = 60;
export const VIEW_W = 320;
export const VIEW_H = 180;
export const COL_W = 8;
export const SHIP_X = 72;
export const SHIP_R = 4;

export class Sim {
  private constructor(private x: Exports) {}

  static async load(bytes: BufferSource): Promise<Sim> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Sim(instance.exports as unknown as Exports);
  }

  private buf(len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.gd_buf(), len);
  }

  newGame(slot: number, seed: Uint8Array): void {
    if (seed.length !== 32) throw new Error("the seed is 32 bytes");
    this.buf(32).set(seed);
    this.x.gd_new(slot);
  }

  /** One tick; returns true when the run is over. */
  step(slot: number, held: boolean): boolean {
    return this.x.gd_step(slot, held ? 1 : 0) === 1;
  }

  tick = (s: number) => this.x.gd_tick(s);
  y = (s: number) => this.x.gd_y(s) / FP;
  vy = (s: number) => this.x.gd_vy(s) / FP;
  cam = (s: number) => this.x.gd_dist(s) / FP;
  gems = (s: number) => this.x.gd_gems(s);
  alive = (s: number) => this.x.gd_alive(s) === 1;
  done = (s: number) => this.x.gd_done(s) === 1;
  score = (s: number) => this.x.gd_score(s);
  metres = (s: number) => this.x.gd_metres(s);

  col(slot: number, k: number): Column | null {
    const p = this.x.gd_col(slot, k);
    if (p < 0) return null;
    const gem = (p >> 16) & 0xff;
    return { top: p & 0xff, bot: (p >> 8) & 0xff, gem: gem === 0 ? null : gem - 1 };
  }

  /** The button-change ticks the slot has recorded. */
  log(slot: number): number[] {
    const n = this.x.gd_log(slot);
    const v = new DataView(this.x.memory.buffer, this.x.gd_buf(), n * 4);
    return Array.from({ length: n }, (_, i) => v.getUint32(i * 4, true));
  }

  /** The slot's state bytes (sha256 of these is `final_state_hash`). */
  state(slot: number): Uint8Array {
    const n = this.x.gd_state(slot);
    return this.buf(n).slice();
  }

  /** Replay a log into `slot`; returns the score, or -1 for a log the sim refuses. */
  replay(slot: number, seed: Uint8Array, log: number[]): number {
    if (log.length > 4000) return -1;
    this.buf(32).set(seed);
    const v = new DataView(this.x.memory.buffer, this.x.gd_buf() + 32, log.length * 4);
    log.forEach((t, i) => v.setUint32(i * 4, t >>> 0, true));
    return this.x.gd_replay(slot, log.length);
  }
}

/** The canonical bytes of a log: each tick as u32 little-endian. `log_hash` is their SHA-256. */
export function logBytes(log: number[]): Uint8Array {
  const out = new Uint8Array(log.length * 4);
  const v = new DataView(out.buffer);
  log.forEach((t, i) => v.setUint32(i * 4, t >>> 0, true));
  return out;
}

/** A simple autopilot (for the demo's scripted players and the kill test): hold the button when the
 *  ship, a few ticks ahead, would be below the middle of the cave `look` pixels ahead. `wobble` adds
 *  human-ish error; at tick `quit` it gives up. Plays live in `slot` and returns the score. */
export function autopilot(sim: Sim, slot: number, seed: Uint8Array, look: number, lead: number, rnd: () => number = () => 0.5, wobble = 0, quit = MAX_TICKS): number {
  sim.newGame(slot, seed);
  while (!sim.done(slot)) {
    if (sim.tick(slot) >= quit) {
      sim.step(slot, true); // gives up: flies into the ceiling
      continue;
    }
    const k = Math.floor((sim.cam(slot) + SHIP_X + look) / COL_W);
    const c = sim.col(slot, k);
    const mid = c ? (c.top + c.bot) / 2 : VIEW_H / 2;
    const err = wobble ? (rnd() - 0.5) * wobble : 0;
    sim.step(slot, sim.y(slot) + sim.vy(slot) * lead + err > mid);
  }
  return sim.score(slot);
}
