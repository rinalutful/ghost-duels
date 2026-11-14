// The verifier's own rules (demo/src/verify-rules.ts), without the network. v4 has no keys and
// anyone can play it, so `npm run verify` must pass in every state a player can reach: these are
// the states that would have failed its first version.
import assert from "node:assert/strict";
import { test } from "node:test";
import { duelListOk, expectedSplit, ladderOk, replaySample, splitOk, type GhostRecord } from "./src/verify-rules.ts";

const N = 10n ** 24n;
const ghost = (over: Partial<GhostRecord>): GhostRecord => ({ id: 1, pot: (N / 5n).toString(), stake: (N / 20n).toString(), qualified_pot: (N / 5n).toString(), defended: 0, forfeits: 0, beaten: 0, earned: "0", grown: "0", raked: "0", challengers: ["bob.testnet"], ...over });
/** A ghost that kept `n` stakes, with the record the contract would write (lib.rs `keep_stake`). */
function kept(stake: bigint, n: number): GhostRecord {
  let [raked, grown, earned] = [0n, 0n, 0n];
  for (let i = 0; i < n; i++) {
    const rake = (stake * 500n) / 10_000n;
    const grow = (stake * 2500n) / 10_000n;
    raked += rake;
    grown += grow;
    earned += stake - rake - grow;
  }
  return ghost({ stake: stake.toString(), defended: n - 1, forfeits: 1, raked: raked.toString(), grown: grown.toString(), earned: earned.toString() });
}

test("a duel its owner closed (an empty list) is a valid duel, not a failure", () => {
  assert.equal(duelListOk(ghost({ challengers: [] })), true);
  assert.equal(duelListOk(ghost({ challengers: ["bob.testnet"] })), true);
  assert.equal(duelListOk(ghost({ challengers: Array.from({ length: 16 }, (_, i) => `p${i}.testnet`) })), true);
});

test("a list the contract would never store still fails: 17 names, or a name twice", () => {
  assert.equal(duelListOk(ghost({ challengers: Array.from({ length: 17 }, (_, i) => `p${i}.testnet`) })), false);
  assert.equal(duelListOk(ghost({ challengers: ["bob.testnet", "bob.testnet"] })), false);
});

test("a stake that doesn't divide by 20 yocto splits as the contract rounds it, and passes", () => {
  // 0.05 NEAR + 1 yocto, the stake a guest could type into the page's form.
  const odd = N / 20n + 1n;
  const g = kept(odd, 3);
  assert.notEqual(BigInt(g.earned) * 5n, BigInt(g.raked) * 70n, "not 70 / 5 to the yocto: the old check failed here");
  assert.equal(splitOk(g), true);
  assert.deepEqual(expectedSplit(odd, 1n), { raked: N / 400n, grown: N / 80n, earned: odd - N / 400n - N / 80n });
  // The smallest stake v4 allows plus 19 yocto, the worst rounding case.
  assert.equal(splitOk(kept(N / 100n + 19n, 7)), true);
});

test("a round stake splits 70 / 25 / 5 to the yocto", () => {
  const g = kept(N / 20n, 2);
  assert.equal(splitOk(g), true);
  assert.equal(BigInt(g.earned) * 5n, BigInt(g.raked) * 70n);
  assert.equal(BigInt(g.grown) * 5n, BigInt(g.raked) * 25n);
  assert.equal(splitOk(ghost({})), true, "a ghost nobody has raced");
});

test("a record that doesn't add up still fails: one yocto off, or a stake kept and not counted", () => {
  const g = kept(N / 20n, 2);
  assert.equal(splitOk({ ...g, earned: (BigInt(g.earned) + 1n).toString() }), false);
  assert.equal(splitOk({ ...g, raked: (BigInt(g.raked) - 1n).toString() }), false);
  assert.equal(splitOk({ ...g, defended: g.defended + 1 }), false);
});

test("a public-ladder ghost holds no money and names no one", () => {
  const l = ghost({ pot: "0", stake: "0", qualified_pot: "0", challengers: [], defended: 3, beaten: 1 });
  assert.equal(ladderOk(l), true);
  assert.equal(ladderOk({ ...l, pot: "1" }), false);
  assert.equal(ladderOk({ ...l, challengers: ["bob.testnet"] }), false);
  assert.equal(ladderOk({ ...l, earned: "1" }), false);
});

test("the replay check stays bounded: every ghost up to 40, then the 20 oldest and the 20 newest", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(replaySample(ids(14)), ids(14));
  const s = replaySample(ids(500));
  assert.equal(s.length, 40);
  assert.deepEqual([s[0], s[19], s[20], s[39]], [1, 20, 481, 500]);
});
