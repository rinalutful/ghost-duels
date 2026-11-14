// `npm run attack`: the attack suite. Each attack is a unit test on the real contract code
// (contracts/ghost-duels/src/tests.rs), most of them an adversarial review's findings turned into
// tests. This prints each attack, what the test asserts the contract does (the wording here is this
// file's; the assertion is the test's), and whether that test passed. Four of the thirty-one are not
// refused but PRICED: the attacker gets what they wanted at a cost the test pins. Needs Rust (the contract's pinned 1.93 toolchain; the first build takes a few minutes).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ATTACKS: [string, string, string][] = [
  ["attack_best_of_n_minting_costs_every_try", "Fish for a lucky cave: fly qualifiers, keep only the best ghost", "a short or abandoned try costs 20% of its pot; a minted ghost's pot is locked for a day"],
  ["attack_wash_trade_shows_its_cost", "Pad a ghost's record: lose to it 20 times from your own second account", "counted, at a price the NFT states: 0.1 NEAR of rake and 0.5 NEAR into the pot"],
  ["attack_wash_trade_near_misses_cost_what_the_record_says", "Same, with faked near misses, then retire the ghost to get the pot share back", "the pot share goes to the house on retire (20 fakes cost ≥ 0.6 NEAR that way); a winning alt can still take it back, so the token claims no price"],
  ["attack_owner_cannot_confiscate_a_qualifier_with_its_terms", "Owner raises the minimum score before a qualifier starts, to take its abandon fee", "refused: min_ghost_score ≤ 1000, and a qualifier's stated max terms are 'above the most you accept'"],
  ["attack_ghost_with_pot_below_stake_cannot_be_raced", "Race a beaten ghost whose pot regrew to 0.025 for a 0.1 stake", "refused: 'this ghost's pot is below its stake'"],
  ["attack_key_cap_counts_losses_not_the_refunded_reserve", "A capped key runs out on the refundable reserve", "only what a run can lose counts: 3 practice runs fit in 0.03"],
  ["attack_cheap_qualifier_then_refill_is_refused", "Fish for caves at the minimum pot, then refill the keeper to 2 NEAR", "refused: 'a refill only restores the pot it qualified with'"],
  ["attack_stolen_session_key_is_capped", "Steal a session key; stake it against your own 2 NEAR ghost", "refused: 'this key has no spending cap', then 'this key's cap is 0.500 NEAR'"],
  ["attack_holding_a_duel_needs_a_named_account_and_costs_every_time", "Hold a duel against its real challengers: start races you never submit", "a stranger can't (not named); the owner's own named account can for 90 s a time, at the rake and pot share each; the next challenger's start closes it (10/10)"],
  ["attack_abandoned_challenges_are_forfeits_and_cost", "Abandon challenges to pad a ghost without flying", "each is a forfeit, not a defence, and costs the rake and the pot share"],
  ["attack_zero_cap_key_cannot_burn_the_balance", "Burn a capped key's balance on practice-run storage", "refused: storage counts toward 'this key's cap'"],
  ["attack_on_chain_only_deploy_refuses_offchain_replayers", "Owner switches the on-chain-only deploy to a runner they control", "refused: 'this deploy replays on-chain only'"],
  ["attack_owner_cannot_change_a_qualifier_mid_run", "Owner raises the minimum score mid-run to collect the abandon fee", "the qualifier keeps the terms it started with, and mints"],
  ["attack_storage_is_paid_on_every_path", "Leave an 8 KB log pending; deposit for free; settle unpaid", "every byte charged to whoever added it; the log's bytes refunded when dropped"],
  ["attack_owner_powers_are_bounded", "Owner: 0.06 NEAR replay fee, 5 s runs, 25% rake, a fake 'OutLayer'", "refused, refused, refused; runs keep their start rake; the fake is 'not verified as a TEE'"],
  ["attack_no_free_refund_for_a_known_loser", "Know you lost; wait for the runner to time out and claim a refund", "no void: anyone replays it on-chain and the loss stands"],
  ["attack_failed_outlayer_call_refunds_the_fee", "OutLayer's request_execution fails after the fee was sent", "the fee comes back to the player; the run is replayed on-chain"],
  ["attack_ghost_ids_past_u32_dont_alias", "Challenge ghost 2^32+1 to lock ghost #1", "refused: 'no such ghost'"],
  ["edited_score_is_refused_and_forfeits", "Claim a higher score than you flew", "refused by the replay; the stake is forfeited"],
  ["malformed_log_refused_at_submit", "Submit a log whose ticks go backwards", "refused: 'the input log's ticks must strictly increase'"],
  ["runner_mode_checks_runner_and_log_hash", "Hand in a replay as a stranger, or a replay of another log", "refused: 'not a registered runner', 'a different log'"],
  ["withdraw_is_full_access_only", "Withdraw with a session key (no deposit)", "refused: 'Requires attached deposit of exactly 1 yoctoNEAR'"],
  ["cannot_challenge_own_ghost", "Challenge your own ghost (to farm it)", "refused: 'that's your own ghost'"],
  ["attack_two_challengers_cannot_race_a_duel_at_once", "Two challengers race the same duel at once (to be paid its pot twice, or to beat each other to it)", "refused: 'a duel takes one race at a time'; the one in flight takes the pot it started for"],
  ["attack_owner_cannot_take_the_pot_from_under_a_racing_challenger", "A duel's owner names a second account mid-race, races one named in advance, or retires, to take the pot before the winner lands (v4's limit, 0022)", "refused, each: 'a race is in flight', 'a duel takes one race at a time'; the challenger lands and takes the pot"],
  ["attack_a_pot_swapped_for_a_smaller_one_is_refused_by_min_pot", "A duel's owner has a second account win the pot, refills a tenth of it, and lets the invited player stake for what the board still showed", "refused: 'this ghost's pot is 0.100 NEAR now, below the 1.000 NEAR you were shown (min_pot)'; nothing is staked"],
  ["late_submit_refused", "Submit after the 90 s deadline (after searching offline)", "refused: 'too late: the run expired'"],
  // v4 (docs/decisions/0019, 0020)
  ["attack_stranger_cannot_race_a_private_duel", "A bot nobody chose races a player's staked ghost", "refused: 'this ghost is a private duel and its owner hasn't named you'; the named player gets in"],
  ["attack_guest_sybils_cannot_reach_staked_play", "20 guest accounts with capped session keys (sybils) go for staked play", "refused every way in; on the public ladder they race, and no money moves"],
  ["attack_mutual_choice_bypasses_are_refused", "A stolen key names the thief; a stranger edits the list; a public ghost takes a pot; a padded list", "refused, each; a ghost given away keeps its list, and only its new owner changes it"],
  ["attack_key_cap_counts_ghost_log_and_settlement_storage", "A key's qualifier stores a long ghost log, and its lost challenge settles (a bug our AI review found)", "the key counts exactly what the balance lost, storage included; a log past the cap is refused"],
  ["property_a_session_key_never_loses_more_than_its_cap", "A thief runs a stolen key flat out: 300 random steps, many runs in flight, settled by anyone", "the victim never loses more than the key's cap, at any step"],
];

// `--stdin`: read the output of a `cargo test -p ghost-duels` run that already happened (npm run judge
// runs the contract's tests once and hands their output here) instead of running the attacks again.
let out: string;
if (process.argv.includes("--stdin")) {
  out = readFileSync(0, "utf8");
} else {
  const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}`, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? new URL("../target", import.meta.url).pathname };
  const r = spawnSync("cargo", ["test", "-p", "ghost-duels", "--", "--test-threads=4", ...ATTACKS.map((a) => a[0])], { cwd: new URL("../contracts", import.meta.url).pathname, env, encoding: "utf8" });
  out = (r.stdout ?? "") + (r.stderr ?? "");
}
/** Attacks that go through, at a price the test pins (the rest are refused or have no effect). */
const PRICED = new Set(["attack_holding_a_duel_needs_a_named_account_and_costs_every_time", "attack_best_of_n_minting_costs_every_try", "attack_wash_trade_shows_its_cost", "attack_wash_trade_near_misses_cost_what_the_record_says"]);
let ok = 0;
let [refused, priced] = [0, 0];
for (const [test, attack, expect] of ATTACKS) {
  const pass = new RegExp(`test tests::${test}( - should panic)? \\.\\.\\. ok`).test(out);
  if (pass) {
    ok++;
    PRICED.has(test) ? priced++ : refused++;
  }
  console.log(`${pass ? "✓" : "✗"} ${PRICED.has(test) ? "[priced] " : "[refused]"} ${attack}\n    → ${expect}`);
}
if (ok !== ATTACKS.length) console.log(out.split("\n").filter((l) => /panicked|FAILED|error/.test(l)).slice(0, 10).join("\n"));
console.log(`\n${ok}/${ATTACKS.length} attacks answered as stated: ${refused} refused, ${priced} priced.`);
process.exit(ok === ATTACKS.length ? 0 : 1);
