// What `npm run verify` asserts about v4's ghosts, as pure functions so demo/verify-rules.test.ts can
// test them without the network.
//
// v4 has no keys: nobody can change it, and anybody can play it. So every check here must hold for
// EVERY state a player can put the contract in, or one guest could turn the judge's table to FAIL
// for everyone after them. Two states the first version of these checks got wrong:
//   - a duel its owner closed (`set_challengers` with an empty list; the page offers it) names nobody;
//   - a stake that isn't a multiple of 20 yoctoNEAR doesn't split 70 / 25 / 5 exactly: the contract
//     rounds the rake and the pot share down and gives the owner the rest (`keep_stake`).
// Both are valid, so the checks state what the contract guarantees, exactly, and nothing more.

export type GhostRecord = {
  id: number;
  pot: string;
  stake: string;
  qualified_pot: string;
  defended: number;
  forfeits: number;
  beaten: number;
  earned: string;
  grown: string;
  raked: string;
  challengers: string[];
};

export const MAX_CHALLENGERS = 16;
/** v4's terms (checked against `get_config` by verify, and fixed per run when it starts). */
export const RAKE_BPS = 500n;
export const POT_BPS = 2500n;

export const isStaked = (g: GhostRecord) => BigInt(g.stake) > 0n;

/** A staked ghost is a private duel: its list holds 0 to 16 accounts, each once. An empty list is a
 *  duel its owner closed (nobody may race it until they name someone), not a public ghost. */
export function duelListOk(g: GhostRecord): boolean {
  return g.challengers.length <= MAX_CHALLENGERS && new Set(g.challengers).size === g.challengers.length;
}

/** A public-ladder ghost holds no money, names no one and has earned nothing. */
export function ladderOk(g: GhostRecord): boolean {
  return g.pot === "0" && g.qualified_pot === "0" && g.challengers.length === 0 && g.earned === "0" && g.grown === "0" && g.raked === "0";
}

/** What `n` kept stakes of `stake` yoctoNEAR pay, exactly as the contract computes it: the rake and
 *  the pot share are rounded down per stake, and the ghost's owner gets the rest. For a stake that
 *  is a multiple of 20 yocto this is 5% / 25% / 70% to the yocto; otherwise the owner's share is up
 *  to 2 yocto per stake above 70%. */
export function expectedSplit(stake: bigint, n: bigint): { raked: bigint; grown: bigint; earned: bigint } {
  const rake = (stake * RAKE_BPS) / 10_000n;
  const grow = (stake * POT_BPS) / 10_000n;
  return { raked: n * rake, grown: n * grow, earned: n * (stake - rake - grow) };
}

/** A staked ghost's record adds up: every stake it kept (a defence or a forfeit) was split by the
 *  contract's own arithmetic. No tolerance is needed, so none is given. */
export function splitOk(g: GhostRecord): boolean {
  const want = expectedSplit(BigInt(g.stake), BigInt(g.defended + g.forfeits));
  return BigInt(g.raked) === want.raked && BigInt(g.grown) === want.grown && BigInt(g.earned) === want.earned;
}

/** Which ghosts' logs to replay: all of them up to `max`, else the oldest and the newest halves, so
 *  the check stays a few seconds however many ghosts players mint. */
export function replaySample<T>(ghosts: T[], max = 40): T[] {
  if (ghosts.length <= max) return ghosts;
  const half = Math.floor(max / 2);
  return [...ghosts.slice(0, half), ...ghosts.slice(ghosts.length - half)];
}
