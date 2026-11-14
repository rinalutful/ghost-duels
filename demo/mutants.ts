// `npm run mutants`: break each security-critical check in the contract, one at a time, and show the
// unit tests catch it (a mutant "survives" if every test still passes). Needs Rust; each mutant is a
// recompile, so this takes 10-20 minutes. Prints "N/N mutants caught" and exits 1 if any survive.
// The source is restored after every mutant, and on Ctrl-C.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const LIB = new URL("../contracts/ghost-duels/src/lib.rs", import.meta.url).pathname;
const NFT = new URL("../contracts/ghost-duels/src/nft.rs", import.meta.url).pathname;
const RULES = new URL("../web/src/rules.ts", import.meta.url).pathname;
type Mutant = { what: string; file: string; from: string; to: string; tests: string; also?: [string, string]; web?: boolean };
const M: Mutant[] = [
  { what: "an edited score is accepted (claim not compared with the replay)", file: LIB, from: "if replay.score != claimed {", to: "if false {", tests: "edited_score" },
  { what: "an owner may challenge their own ghost", file: LIB, from: `require!(g.owner != player, "that's your own ghost");`, to: "", tests: "own_ghost" },
  { what: "a settled challenge stays counted as racing (retire blocked forever)", file: LIB, from: "g.racing = g.racing.saturating_sub(1);", to: "", tests: "two_challengers holding_a_duel" },
  { what: "a session key spends past its cap", file: LIB, from: "if let Some((_, kc)) = self.key_cap_entry(who) {\n            if kc.spent.0 + amount > kc.cap.0 {", to: "if let Some((_, kc)) = self.key_cap_entry(who) {\n            if false {", tests: "stolen_session_key" },
  { what: "any deposit counts as a full-access key", file: LIB, from: "if env::attached_deposit().as_yoctonear() == 1 {", to: "if true {", tests: "stolen_session_key" },
  { what: "a kept stake doesn't grow the pot", file: LIB, from: "let grow = bps(run.stake.0, run.pot_bps);", to: "let grow = 0;", tests: "stake_is_split" },
  { what: "a ghost's pot can be retired at once", file: LIB, from: "env::block_timestamp_ms() >= g.pot_locked_until_ms", to: "true", tests: "best_of_n" },
  { what: "a failed qualifier costs nothing", file: LIB, from: "let fee = bps(pot, run.abandon_bps);", to: "let fee = 0;", tests: "best_of_n" },
  { what: "a runner's replay of another log is accepted", file: LIB, from: `require!(Some(&result.log_hash) == run.log_hash.as_ref(), "that replay is of a different log than the one submitted");`, to: "", tests: "runner_mode" },
  { what: "anyone can hand in a replay", file: LIB, from: `require!(self.config.runners.contains(&runner), "not a registered runner");`, to: "", tests: "runner_mode" },
  { what: "a run is submitted after its deadline", file: LIB, from: `require!(env::block_timestamp_ms() <= run.deadline_ms, "too late: the run expired");`, to: "", tests: "late_submit" },
  { what: "a first deposit doesn't pay for its storage", file: LIB, from: "self.balances.insert(who, b - cost);", to: "self.balances.insert(who, b);", tests: "property_ledger" },
  { what: "settlement's storage isn't charged at all", file: LIB, from: "let cost = (now - before) as u128 * byte;", to: "let cost = 0u128;", tests: "property_ledger storage_is_paid" },
  { what: "a failed OutLayer call keeps the player's fee", file: LIB, from: "                run.fee_spent = false;\n", to: "", tests: "failed_outlayer" },
  { what: "ghost ids past u32 alias (a truncating cast)", file: LIB, from: "id.checked_sub(1).and_then(|i| u32::try_from(i).ok())", to: "id.checked_sub(1).map(|i| i as u32)", tests: "past_u32" },
  { what: "the replay fee has no cap", file: LIB, from: `require!(replay_fee.0 <= MAX_REPLAY_FEE, "replay fee at most 0.05 NEAR");`, to: "", tests: "owner_powers" },
  { what: "a winner leaves the pot in the ghost", file: LIB, from: "                g.pot = U128(0);\n                g.grown_in_pot = U128(0);\n                g.beaten += 1;", to: "                g.beaten += 1;", tests: "beaten_ghost" },
  { what: "anyone can transfer a ghost", file: NFT, from: `require!(&g.owner == sender, "only the ghost's owner can transfer it");`, to: "", tests: "only_owner_transfers" },
  { what: "a refill grows a cheap ghost's pot past what it qualified with", file: LIB, from: "require!(g.pot.0 - g.grown_in_pot.0 + amount.0 <= g.qualified_pot.0,", to: "require!(true,", tests: "cheap_qualifier" },
  { what: "retiring gives the owner back the pot share of faked defences", file: LIB, from: "self.credit(&who, g.pot.0 - g.grown_in_pot.0);\n        self.credit(&self.config.owner.clone(), g.grown_in_pot.0);", to: "self.credit(&who, g.pot.0);", tests: "near_misses" },
  { what: "a session key's runs don't count their own storage against its cap", file: LIB, from: "self.spend_from_key(&player, stake + pot + fee + storage + reserve);", to: "self.spend_from_key(&player, stake + pot + fee + reserve);", tests: "key_cap_counts zero_cap" },
  { what: "the owner sets any minimum score", file: LIB, from: `require!(min_ghost_score <= 1000, "min_ghost_score at most 1000");`, to: "", tests: "confiscate" },
  { what: "a qualifier's stated maximum terms are ignored", file: LIB, from: "if q.max_min_score.is_some_and(", to: "if false && q.max_min_score.is_some_and(", tests: "confiscate" },
  { what: "a ghost whose pot is below its stake can be raced", file: LIB, from: `require!(g.pot.0 >= g.stake.0, "this ghost's pot is below its stake; its owner can refill it");`, to: "", tests: "pot_below_stake" },
  { what: "the refundable reserve stays counted against a key's cap after settlement", file: LIB, from: "kc.spent = U128(kc.spent.0.saturating_sub(held) + charged);", to: "kc.spent = U128(kc.spent.0 + charged);", tests: "key_cap_counts" },
  { what: "an on-chain-only deploy can be switched to a runner", file: LIB, from: "require!(self.config.offchain_allowed,", to: "require!(true,", tests: "on_chain_only" },
  { what: "a qualifier is judged by the owner's current minimum score", file: LIB, from: "if replay.score >= run.min_ghost_score {", to: "if replay.score >= self.config.min_ghost_score {", tests: "mid_run" },
  // v4 (docs/decisions/0019, 0020): private duels, and key caps that count every byte.
  { what: "a stranger may race a private duel", file: LIB, from: "require!(g.challengers.contains(&player),", to: "require!(true,", tests: "stranger_cannot guest_sybils" },
  { what: "a session key may name who races the account's money", file: LIB, from: `require!(env::attached_deposit().as_yoctonear() == 1, "choosing who may race your money`, to: `require!(true, "choosing who may race your money`, tests: "guest_sybils mutual_choice" },
  { what: "a staked ghost may be open to anyone (no challengers named)", file: LIB, from: "Self::check_challengers(named, 1);", to: "Self::check_challengers(named, 0);", tests: "guest_sybils mutual_choice" },
  { what: "anyone may set a ghost's challengers", file: LIB, from: "let g = self.ghost(ghost_id);\n        require!(g.owner == who, \"not your ghost\");\n        require!(g.stake.0 > 0, \"a public-ladder", to: "let g = self.ghost(ghost_id);\n        require!(g.stake.0 > 0, \"a public-ladder", tests: "mutual_choice" },
  { what: "a session key may set a ghost's challengers", file: LIB, from: "near_sdk::assert_one_yocto();\n        let who = env::predecessor_account_id();\n        let g = self.ghost(ghost_id);\n        require!(g.owner == who, \"not your ghost\");\n        require!(g.stake.0 > 0", to: "let who = env::predecessor_account_id();\n        let g = self.ghost(ghost_id);\n        require!(g.owner == who, \"not your ghost\");\n        require!(g.stake.0 > 0", tests: "mutual_choice" },
  { what: "a qualifier doesn't hold its recording's storage from the start (a good run can be refused at submit, #34)", file: LIB, from: "if qualify.is_some() { SETTLE_RESERVE_BYTES + GHOST_LOG_BYTES }", to: "if qualify.is_some() { SETTLE_RESERVE_BYTES }", tests: "can_always_submit key_cap_counts settlement_storage" },
  { what: "settlement's storage isn't counted on the key (a bug our AI review found)", file: LIB, from: "self.release_run_key(&run, held, from_reserve + from_balance);", to: "self.release_run_key(&run, held, 0);", tests: "key_cap_counts" },
  { what: "a run's reserve isn't held on its key while in flight (charged only at settlement)", file: LIB, from: "self.spend_from_key(&player, stake + pot + fee + storage + reserve);", to: "self.spend_from_key(&player, stake + pot + fee + storage);", also: ["kc.spent = U128(kc.spent.0.saturating_sub(held) + charged);", "kc.spent = U128(kc.spent.0 + charged);"], tests: "property_a_session key_cap_counts" },
  // v5 (docs/decisions/0023): a duel takes one race at a time; a failed withdrawal comes back.
  { what: "two challengers race a duel at once (the first to settle takes the pot from the other)", file: LIB, from: "require!(g.lock_run.is_none() || stale.is_some(),", to: "require!(true,", tests: "two_challengers under_a_racing" },
  { what: "a duel's list changes while a race is in flight", file: LIB, from: `require!(g.racing == 0, "a race is in flight`, to: `require!(true, "a race is in flight`, tests: "under_a_racing" },
  { what: "a settled race keeps its duel locked", file: LIB, from: "            if g.lock_run == Some(run.id) {\n                g.lock_run = None;\n            }\n", to: "", tests: "two_challengers holding_a_duel" },
  { what: "a race that was never submitted holds its duel for ever", file: LIB, from: "r.status == Status::Playing && now > r.deadline_ms", to: "false", tests: "stale_race holding_a_duel" },
  { what: "an owner names themselves as their ghost's challenger", file: LIB, from: "require!(!challengers.contains(&who),", to: "require!(true,", tests: "under_a_racing" },
  { what: "a withdrawal whose transfer failed is lost", file: LIB, from: "        self.credit(&account_id, amount.0);\n        emit(\"withdraw_failed\"", to: "        emit(\"withdraw_failed\"", tests: "failed_withdrawal" },
  { what: "a challenger's min_pot is ignored (a pot won and refilled smaller is raced for the same stake)", file: LIB, from: "require!(g.pot.0 >= m.0,", to: "require!(true,", tests: "smaller_one" },
  { what: "retire reads the pot lock before it closes a stale race (the forfeit's growth is retired at once)", file: LIB, from: "self.expire_stale_lock(ghost_id);\n        let mut g = self.ghost(ghost_id);\n        require!(env::block_timestamp_ms() >= g.pot_locked_until_ms, format!(\"this pot is locked until {} ms (pot_lock_secs after it was minted, refilled or grew)\", g.pot_locked_until_ms));", to: "require!(env::block_timestamp_ms() >= g.pot_locked_until_ms, \"this pot is locked until later\");\n        self.expire_stale_lock(ghost_id);\n        let mut g = self.ghost(ghost_id);", tests: "closed_by_retire" },
  { what: "the page hides a ghost someone is racing", file: RULES, from: "if (BigInt(g.pot) === 0n) return", to: "if (BigInt(g.pot) === 0n || g.racing > 0) return", tests: "", web: true },
  { what: "the page's start_run leaves out max_fee", file: RULES, from: "return { ghost_id: ghostId, max_fee: cfg.replay_fee, min_pot: pot };", to: "return { ghost_id: ghostId, min_pot: pot } as never;", tests: "", web: true },
  { what: "the page's start_run leaves out min_pot (the pot it showed)", file: RULES, from: "return { ghost_id: ghostId, max_fee: cfg.replay_fee, min_pot: pot };", to: "return { ghost_id: ghostId, max_fee: cfg.replay_fee } as never;", tests: "", web: true },
  { what: "a hidden tab doesn't end a real run", file: RULES, from: "return hidden || left <= SUBMIT_MARGIN_MS;", to: "return left <= SUBMIT_MARGIN_MS;", tests: "", web: true },
  { what: "the page offers a duel for real to an account its owner didn't name", file: RULES, from: "return me !== null && (g.challengers ?? []).includes(me);", to: "return me !== null;", tests: "", web: true },
  { what: "a link may point the page at anything, not only an account id", file: RULES, from: "return asked && ACCOUNT.test(asked) ? asked : fallback;", to: "return asked ?? fallback;", tests: "", web: true },
  { what: "the page draws a contract's answer as it came (a score that is markup)", file: RULES, from: "score: num(g.score),", to: "score: g.score as number,", tests: "", web: true },
  { what: "the page names a duel's challengers with the session key (no 1 yoctoNEAR)", file: RULES, from: "max_fee: cfg.replay_fee }, deposit: 1n };", to: "max_fee: cfg.replay_fee }, deposit: 0n };", tests: "", web: true },
];

const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}`, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? new URL("../target", import.meta.url).pathname };
const originals = new Map([LIB, NFT, RULES].map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => originals.forEach((src, f) => writeFileSync(f, src));
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
// Every target must be in its file exactly once before any mutant runs.
for (const [i, m] of M.entries()) {
  const src = originals.get(m.file)!;
  if (src.split(m.from).length !== 2 || (m.also && src.replace(m.from, m.to).split(m.also[0]).length !== 2)) throw new Error(`mutant ${i + 1}: its target isn't in ${m.file} exactly once: ${m.from}`);
}
const only = process.argv[2];
let caught = 0;
const list = M.filter((m, i) => !only || String(i + 1) === only);
const t0 = Date.now();
for (const [i, m] of list.entries()) {
  const src = originals.get(m.file)!;
  if (src.split(m.from).length !== 2) throw new Error(`mutant ${i + 1}: its target isn't in ${m.file} exactly once: ${m.from}`);
  let mutated = src.replace(m.from, m.to);
  if (m.also) {
    if (mutated.split(m.also[0]).length !== 2) throw new Error(`mutant ${i + 1}: its second target isn't there exactly once`);
    mutated = mutated.replace(m.also[0], m.also[1]);
  }
  writeFileSync(m.file, mutated);
  const r = m.web
    ? spawnSync("npx", ["tsx", "--test", "web-rules.test.ts"], { cwd: new URL(".", import.meta.url).pathname, env, encoding: "utf8" })
    : spawnSync("cargo", ["test", "-q", "-p", "ghost-duels", "--", ...m.tests.split(" ")], { cwd: new URL("../contracts", import.meta.url).pathname, env, encoding: "utf8" });
  restore();
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const compiled = !/error\[E\d+\]|error: could not compile/.test(out);
  const killed = r.status !== 0 && compiled;
  if (killed) caught++;
  const failing = m.web ? (out.match(/^✖ (.+?) \(/m)?.[1] ?? "web-rules") : (out.match(/^    tests::\S+/gm)?.map((s) => s.trim().replace("tests::", "")).join(", ") ?? "");
  console.log(`${killed ? "✓ caught " : compiled ? "✗ SURVIVED" : "✗ didn't compile"}  ${String(i + 1).padStart(2)}. ${m.what.padEnd(66)} ${killed ? `by ${failing}` : ""}`);
}
restore();
console.log(`\n${caught}/${list.length} mutants caught (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(caught === list.length ? 0 : 1);
