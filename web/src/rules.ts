// The page's rules about the chain's state, kept pure so demo/web-rules.test.ts can test them
// without a browser.

export type GhostLike = { id?: number; owner?: string; pot: string; stake?: string; racing: number; challengers?: string[] };
export type ConfigLike = { replay_fee: string };

/** Staked ghosts are private duels between players who chose each other; ghosts with no stake are
 *  the public ladder, where no money moves (docs/decisions/0019). */
export function ghostKind(g: GhostLike): "duel" | "ladder" {
  return BigInt(g.stake ?? "1") > 0n ? "duel" : "ladder";
}

/** What the ghost list says about a ghost. A ladder ghost holds no pot and is always open: any
 *  number may race it at once (docs/decisions/0015). A duel takes one race at a time (0023): while
 *  one is in flight the list says so, and the Race button stays, because that race may be past its
 *  deadline (the next start closes it) and the contract's own answer says exactly when to retry. */
export function ghostState(g: GhostLike): { open: boolean; label: string } {
  if (ghostKind(g) === "ladder") return { open: true, label: g.racing > 0 ? `${g.racing} racing now` : "public ladder" };
  if (BigInt(g.pot) === 0n) return { open: false, label: "beaten" };
  if (BigInt(g.pot) < BigInt(g.stake ?? "0")) return { open: false, label: "pot below its stake" };
  return { open: true, label: g.racing > 0 ? "a race is in flight (90 s at most)" : "open" };
}

/** Whether `me` may race `g` for real: never your own ghost; a duel only if its owner named you. */
export function canRace(g: GhostLike, me: string | null): boolean {
  if (!ghostState(g).open) return false;
  if (me && g.owner === me) return false;
  if (ghostKind(g) === "ladder") return true;
  return me !== null && (g.challengers ?? []).includes(me);
}

/** start_run's arguments: the page always caps the replay fee at the one it showed the player, and
 *  asks for at least the pot it showed (`min_pot`: v5 refuses a start against a pot that was won
 *  and refilled smaller meanwhile; v4 ignores the argument, so there the page's own re-read of the
 *  ghost just before the start is all there is). */
export function startArgs(ghostId: number, cfg: ConfigLike, pot: string): { ghost_id: number; max_fee: string; min_pot: string } {
  return { ghost_id: ghostId, max_fee: cfg.replay_fee, min_pot: pot };
}

export const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

// ---------- nothing the chain (or a link) says is trusted as HTML ----------
// The page can be pointed at another deploy with #contract=<account>, so a link can choose whose
// view calls fill the board. Whatever comes back is coerced to the type the page expects before it
// is drawn: a number is a number, an amount is digits, an account id matches NEAR's grammar. Free
// text (a run's note) is escaped where it is shown.

/** The contract a link asks for, if it is a NEAR account id; else the default. */
export function contractFrom(asked: string | null | undefined, fallback: string): string {
  return asked && ACCOUNT.test(asked) ? asked : fallback;
}
const num = (v: unknown): number => {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
const amount = (v: unknown): string => (typeof v === "string" && /^\d{1,39}$/.test(v) ? v : "0");
const account = (v: unknown): string => (typeof v === "string" && ACCOUNT.test(v) ? v : "invalid-account");
const hex64 = (v: unknown): string => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export type CleanGhost = { id: number; owner: string; pilot: string; score: number; metres: number; gems: number; ticks: number; pot: string; stake: string; qualified_pot: string; grown_in_pot: string; defended: number; forfeits: number; beaten: number; best_challenge: number; earned: string; grown: string; raked: string; racing: number; seed: string; log_hash: string; challengers: string[]; pot_locked_until_ms: number };
export function cleanGhost(v: unknown): CleanGhost {
  const g = rec(v);
  return {
    id: num(g.id), owner: account(g.owner), pilot: account(g.pilot), score: num(g.score), metres: num(g.metres), gems: num(g.gems), ticks: num(g.ticks),
    pot: amount(g.pot), stake: amount(g.stake), qualified_pot: amount(g.qualified_pot), grown_in_pot: amount(g.grown_in_pot),
    defended: num(g.defended), forfeits: num(g.forfeits), beaten: num(g.beaten), best_challenge: num(g.best_challenge),
    earned: amount(g.earned), grown: amount(g.grown), raked: amount(g.raked), racing: num(g.racing), seed: hex64(g.seed), log_hash: hex64(g.log_hash),
    challengers: Array.isArray(g.challengers) ? g.challengers.slice(0, 16).map(account) : [], pot_locked_until_ms: num(g.pot_locked_until_ms),
  };
}

const STATUSES = ["Playing", "Replaying", "Verified", "Minted", "Unqualified", "Won", "Lost", "Refused", "Expired"];
export type CleanRun = { id: number; seed: string; status: string; note: string | null; stake: string; minted: number | null; started_ms: number; deadline_ms: number; replay: { score: number; via: string } | null };
export function cleanRun(v: unknown): CleanRun {
  const r = rec(v);
  const rp = r.replay ? rec(r.replay) : null;
  return {
    id: num(r.id), seed: hex64(r.seed), status: STATUSES.includes(r.status as string) ? (r.status as string) : "Unknown", note: typeof r.note === "string" ? r.note.slice(0, 400) : null,
    stake: amount(r.stake), minted: r.minted == null ? null : num(r.minted), started_ms: num(r.started_ms), deadline_ms: num(r.deadline_ms),
    replay: rp ? { score: num(rp.score), via: typeof rp.via === "string" ? rp.via.slice(0, 200) : "" } : null,
  };
}
/** A ghost's stored inputs: a seed and increasing ticks below 3600, at most 2048 of them. */
export function cleanLog(v: unknown): { seed: string; log: number[] } {
  const l = rec(v);
  const log = Array.isArray(l.log) ? l.log.slice(0, 2048).map(num).filter((t) => t < 3600) : [];
  return { seed: hex64(l.seed), log };
}

/** A qualifier's terms from the form: a public-ladder ghost (no pot, no stake, no list) or a private
 *  duel (pot ≥ stake > 0, 1 to 16 named accounts, not yourself). A duel's start is signed by the
 *  full-access key with 1 yoctoNEAR (`deposit`); the ladder's by the session key. */
export function qualifyArgs(kind: "ladder" | "duel", me: string, pot: string, stake: string, names: string, cfg: ConfigLike, yocto: (n: string) => string): { args: Record<string, unknown>; deposit: bigint } {
  if (kind === "ladder") return { args: { qualify: { pot: "0", stake: "0" }, max_fee: cfg.replay_fee }, deposit: 0n };
  const challengers = [...new Set(names.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (challengers.length < 1 || challengers.length > 16) throw new Error("name 1 to 16 challengers: the accounts of the players who agreed to race it");
  const bad = challengers.find((a) => !ACCOUNT.test(a));
  if (bad) throw new Error(`"${bad}" isn't a NEAR account id`);
  if (challengers.includes(me)) throw new Error("you can't race your own ghost: name someone else");
  const [p, s] = [yocto(pot), yocto(stake)];
  if (BigInt(s) <= 0n || BigInt(p) < BigInt(s)) throw new Error("a duel needs a stake, and a pot at least as big as the stake");
  return { args: { qualify: { pot: p, stake: s, challengers }, max_fee: cfg.replay_fee }, deposit: 1n };
}

/** What a qualifier needs in the in-game balance beyond its pot, at the chain's 10^19 yocto per
 *  byte, with a little for the run's own record.
 *  - v5 holds it all from start_run and refunds what isn't used: the settlement reserve (2,000
 *    bytes) and the longest recording a ghost can keep (2,048 button changes, 4 bytes each, plus
 *    its key). The page asks for the same, so it never sends a start the contract will refuse.
 *  - v4 takes the recording's storage when the run is SUBMITTED, not when it starts: a player
 *    without it can't submit a good run and forfeits 20% of the pot when it expires (#34). There
 *    the page keeps back a recording of 750 changes (a full minute at 12 a second; people fly 2
 *    to 5 a second) and refuses to start a qualifier the balance couldn't finish. */
export function qualifierSpare(version: string): bigint {
  return BigInt(2_000 + (version === "v4" ? 750 : 2_048) * 4 + 64 + 1_000) * 10n ** 19n;
}
/** Null if `balance` can finish a qualifier with this pot; else what to tell the player. */
export function qualifierShortfall(balance: bigint, pot: bigint, fmt: (y: bigint) => string, version = "v4"): string | null {
  const spare = qualifierSpare(version);
  const need = pot + spare;
  if (balance >= need) return null;
  return `Your in-game balance is ${fmt(balance)} NEAR. ${pot > 0n ? `A ${fmt(pot)} pot` : "A ghost"} needs ${fmt(need)}: ${pot > 0n ? "the pot, plus " : ""}about ${fmt(spare)} held while you fly for the ghost's recording (what isn't used comes back).${pot > 0n ? " Lower the pot, or fly for the public ladder." : ""}`;
}

/** The link that invites a named challenger to a duel. */
export function inviteLink(base: string, contract: string, ghostId: number, defaultContract: string): string {
  return `${base.split("#")[0]}#duel=${ghostId}${contract === defaultContract ? "" : `&contract=${contract}`}`;
}

/** Milliseconds a real run has left before the contract's deadline, by the local clock. `startedLocal`
 *  is when start_run's result arrived here; the chain's clock started the deadline at `started_ms`,
 *  which is earlier, so this errs on the early side. */
export function msLeft(run: { started_ms: number; deadline_ms: number }, startedLocal: number, now: number): number {
  return run.deadline_ms - run.started_ms - (now - startedLocal);
}

/** A real run ends itself (the button released, the ship flying on to its crash) this long before
 *  the deadline, so the submit lands in time; and at once if the tab is hidden, since a hidden tab
 *  stops the game clock while the chain's keeps going. */
export const SUBMIT_MARGIN_MS = 12_000;
export function mustEndNow(left: number, hidden: boolean): boolean {
  return hidden || left <= SUBMIT_MARGIN_MS;
}
