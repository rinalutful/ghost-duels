// The game's sounds: a handful of synthesized blips (WebAudio oscillators and a noise burst), no
// audio files. Nothing here makes a sound, or even an AudioContext, until the player's first key or
// touch (browsers refuse audio before a gesture, and a page that plays by itself is rude). The mute
// button's choice is kept in this browser.
type Ctx = AudioContext;
const KEY = "ghost-duels-sound";

let ac: Ctx | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
})();
/** How many sounds were asked for and actually scheduled (read by the page test). */
let played = 0;

/** The player's first input: from here on sounds may play. Safe to call on every input. */
export function unlock() {
  if (muted || ac) return void ac?.resume().catch(() => {});
  const A = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!A) return;
  try {
    ac = new A();
  } catch {
    ac = null;
  }
}

export const isMuted = () => muted;
/** Mute or unmute. Resolves once the audio context has stopped or is running again, so a sound
 *  asked for right after unmuting is heard. */
export async function setMuted(v: boolean) {
  muted = v;
  try {
    localStorage.setItem(KEY, v ? "off" : "on");
  } catch {
    // private mode: the choice lasts for this visit
  }
  if (v) return void (await ac?.suspend().catch(() => {}));
  unlock();
  await ac?.resume().catch(() => {});
}
/** For the page test: whether an AudioContext exists yet, and how many sounds were scheduled. */
export const soundState = () => ({ muted, context: ac ? ac.state : "none", played });

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; to?: number; at?: number } = {}) {
  if (muted || !ac || ac.state !== "running") return;
  const t = ac.currentTime + (opts.at ?? 0);
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = opts.type ?? "square";
  o.frequency.setValueAtTime(freq, t);
  if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.08, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
  played++;
}

function noise(dur: number, gain: number) {
  if (muted || !ac || ac.state !== "running") return;
  const n = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  const src = ac.createBufferSource();
  const g = ac.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(g).connect(ac.destination);
  src.start();
  played++;
}

/** A gem: two quick rising notes. */
export function gem() {
  tone(988, 0.07, { gain: 0.07 });
  tone(1480, 0.11, { gain: 0.07, at: 0.06 });
}
/** Your crash: a burst of noise over a falling thud. */
export function crash() {
  noise(0.35, 0.22);
  tone(160, 0.4, { type: "sawtooth", gain: 0.14, to: 38 });
}
/** The moment your score passes the ghost's: a short rising run. */
export function pass() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, { type: "triangle", gain: 0.11, at: i * 0.07 }));
}
/** The ghost's recorded run ends: a soft falling note. */
export function ghostDown() {
  tone(330, 0.22, { type: "triangle", gain: 0.06, to: 165 });
}
/** The countdown: a tick for 3, 2, 1 and a higher one for go. */
export function count(go: boolean) {
  tone(go ? 880 : 440, go ? 0.16 : 0.07, { gain: 0.06 });
}
