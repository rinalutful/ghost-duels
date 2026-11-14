use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;

/// The key the tests' apps sign with (a session key).
fn session_pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

fn ctx(who: &str, deposit: u128, now_ms: u64, seed: u8) {
    ctx_pk(who, deposit, now_ms, seed, None);
}

fn ctx_pk(who: &str, deposit: u128, now_ms: u64, seed: u8, pk: Option<PublicKey>) {
    // The mock keeps storage between contexts but takes `storage_usage` from each new context:
    // carry it over, so usage measured across calls is the chain's running total.
    let usage = env::storage_usage();
    let mut b = VMContextBuilder::new();
    b.storage_usage(usage);
    b.current_account_id(acc("duels.test"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .random_seed([seed; 32])
        .account_balance(NearToken::from_near(1000));
    if let Some(pk) = pk {
        b.signer_account_pk(pk);
    }
    testing_env!(b.build());
}

/// The contract calling itself back (`on_replay`) with one promise result.
fn ctx_callback(now_ms: u64, result: PromiseResult) {
    let c = VMContextBuilder::new()
        .storage_usage(env::storage_usage())
        .current_account_id(acc("duels.test"))
        .predecessor_account_id(acc("duels.test"))
        .signer_account_id(acc("bob.test"))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(1000))
        .build();
    testing_env!(c, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

/// Fly the cave of `seed` with a simple autopilot; `look` px ahead, `lead` ticks of lead; gives up
/// (flies into the ceiling) at `max_ticks`. Returns the log (button-change ticks) and the score.
fn fly(seed_hex: &str, look: i32, lead: i32, max_ticks: u32) -> (Vec<u32>, u32) {
    let seed = unhex32(seed_hex);
    let mut g = ghost_sim::Game::new(&seed);
    let mut log = vec![];
    while !g.done {
        let k = ((g.cam() + ghost_sim::SHIP_X + look) / ghost_sim::COL_W) as u32;
        let c = g.column(k).unwrap();
        let mid = (c.top as i32 + c.bot as i32) / 2 * ghost_sim::FP;
        let mut want = g.y + g.vy * lead > mid;
        if g.tick >= max_ticks {
            want = true;
        }
        let want = if log.len() == ghost_sim::MAX_TOGGLES { g.held } else { want };
        if want != g.held {
            log.push(g.tick);
        }
        g.step(want);
    }
    (log, g.score())
}

/// A contract in OnChain mode with alice and bob holding 5 NEAR each.
fn setup() -> GhostDuels {
    ctx("owner.test", 0, 1_000, 1);
    let mut c = GhostDuels::new(acc("owner.test"), ReplayMode::OnChain, true);
    for who in ["alice.test", "bob.test"] {
        ctx(who, 5 * NEAR, 1_000, 1);
        c.deposit();
    }
    c
}

/// The tests' players, named as challengers by every staked ghost the tests mint (a private duel,
/// docs/decisions/0019); the private-duel attacks below use their own lists.
const PLAYERS: [&str; 13] = ["alice.test", "bob.test", "carol.test", "dave.test", "erin.test", "alice-alt.test", "thief.test", "anyone.test", "p1.test", "p2.test", "p3.test", "owner.test", "runner.test"];

fn named(list: &[&str]) -> Option<Vec<AccountId>> {
    Some(list.iter().map(|a| acc(a)).collect())
}

/// A qualifier's terms. Call it with the player's context set: a duel names every test player but
/// the one flying it (nobody names themselves, 0023).
fn q(pot: u128, stake: u128) -> Option<Qualify> {
    let me = env::predecessor_account_id();
    let others: Vec<&str> = PLAYERS.iter().copied().filter(|p| *p != me.as_str()).collect();
    let challengers = if pot == 0 && stake == 0 { None } else { named(&others) };
    Some(Qualify { pot: U128(pot), stake: U128(stake), max_min_score: None, max_abandon_bps: None, challengers })
}

/// alice flies a qualifier (pot 1 NEAR, stake 0.1, locked before the cave exists); it becomes a ghost.
fn mint_alice(c: &mut GhostDuels) -> (Ghost, u32) {
    ctx("alice.test", 1, 2_000, 7);
    let run = c.start_run(None, q(NEAR, NEAR / 10), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 900);
    ctx("alice.test", 0, 30_000, 7);
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Minted, "{:?}", r.note);
    (c.get_ghost(r.minted.unwrap()).unwrap(), score)
}

fn challenge(c: &mut GhostDuels, who: &str, gid: u64, t: u64, seed: u8, quit: u32, claim: Option<u32>) -> Run {
    ctx(who, 1, t, seed);
    let run = c.start_run(Some(gid), None, None, None);
    let (log, score) = fly(&run.seed, 24, 6, quit);
    ctx(who, 0, t + 20_000, seed);
    c.submit_run(run.id, log, claim.unwrap_or(score)).unwrap()
}

/// Runs `f`, which must panic, and returns its message. Only for refusals that come before any state
/// change (the reopened copy's collections write what they hold when dropped).
fn expect_panic(f: impl FnOnce()) -> String {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    match r {
        Ok(_) => panic!("expected a refusal"),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    }
}

/// A second handle on the contract over the same mocked storage (for a refusal inside catch_unwind):
/// flush, then copy the state struct (collection lengths and prefixes) through borsh.
fn reopen(c: &mut GhostDuels) -> GhostDuels {
    c.flush();
    near_sdk::borsh::from_slice(&near_sdk::borsh::to_vec(&*c).unwrap()).unwrap()
}

fn bal(c: &GhostDuels, who: &str) -> u128 {
    c.get_balance(acc(who)).0
}

// ---------------- the loop ----------------

#[test]
fn qualifier_becomes_a_ghost_on_chain() {
    let mut c = setup();
    let (g, score) = mint_alice(&mut c);
    assert_eq!((g.id, g.score, g.pot.0, g.stake.0), (1, score, NEAR, NEAR / 10));
    assert!(score >= 100, "the qualifier scores {score}");
    assert!(bal(&c, "alice.test") < 4 * NEAR, "the pot left alice's balance");
    let t = c.nft_token("1".into()).unwrap();
    assert_eq!(t.owner_id, acc("alice.test"));
    let md = t.metadata.unwrap();
    assert!(md.title.unwrap().contains(&format!("{score} pts")));
    assert!(md.media.unwrap().starts_with("data:image/svg+xml"));
    assert_eq!(c.nft_total_supply().0, 1);
    assert_eq!(c.get_ghost_log(1).unwrap()["log_hash"], json!(g.log_hash));
}

#[test]
fn challenger_loses_stake_is_split_rake_pot_owner() {
    let mut c = setup();
    mint_alice(&mut c);
    let (a0, o0) = (bal(&c, "alice.test"), bal(&c, "owner.test"));
    let r = challenge(&mut c, "bob.test", 1, 40_000, 9, 120, None);
    assert_eq!(r.status, Status::Lost, "{:?}", r.note);
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.defended, g.forfeits, g.beaten, g.racing), (1, 0, 0, 0));
    let stake = NEAR / 10;
    assert_eq!(bal(&c, "alice.test") - a0, stake * 70 / 100, "the owner's 70%");
    assert_eq!(bal(&c, "owner.test") - o0, stake * 5 / 100, "the house's 5%");
    assert_eq!(g.pot.0, NEAR + stake * 25 / 100, "the pot grew 25%");
    assert_eq!((g.earned.0, g.grown.0, g.raked.0), (stake * 70 / 100, stake * 25 / 100, stake * 5 / 100));
    assert_eq!(g.best_challenge, r.replay.unwrap().score);
}

#[test]
fn challenger_wins_takes_the_pot() {
    let mut c = setup();
    let (_, ghost_score) = mint_alice(&mut c);
    let b0 = bal(&c, "bob.test");
    let r = challenge(&mut c, "bob.test", 1, 40_000, 11, 3600, None);
    assert_eq!(r.status, Status::Won, "{:?}", r.note);
    assert!(r.replay.unwrap().score > ghost_score);
    let b1 = bal(&c, "bob.test");
    assert!(b1 > b0 + NEAR * 99 / 100, "bob won about the pot: {b0} -> {b1}");
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.pot.0, g.beaten), (0, 1));
}

#[test]
#[should_panic(expected = "this ghost has no pot")]
fn beaten_ghost_needs_refill() {
    let mut c = setup();
    mint_alice(&mut c);
    challenge(&mut c, "bob.test", 1, 40_000, 11, 3600, None);
    ctx("bob.test", 1, 100_000, 13);
    c.start_run(Some(1), None, None, None);
}

#[test]
fn practice_run_is_verified_and_its_fee_and_reserve_come_back() {
    let mut c = setup();
    ctx("owner.test", 0, 1_500, 1);
    c.set_params(500, 2500, 2000, U128(MILLI * 10), 90, 300, 86_400, 100, U128(MILLI * 10));
    let b0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 2_000, 3);
    let run = c.start_run(None, None, None, None);
    assert_eq!(run.fee.0, MILLI * 10);
    let (log, score) = fly(&run.seed, 24, 6, 600);
    ctx("bob.test", 0, 20_000, 3);
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Verified);
    let spent = b0 - bal(&c, "bob.test");
    assert!(spent < MILLI * 5, "only the run's storage is kept (no replay fee on-chain): {}", fmt_near(spent));
}

// ---------------- cheats ----------------

#[test]
fn edited_score_is_refused_and_forfeits() {
    let mut c = setup();
    let (_, ghost_score) = mint_alice(&mut c);
    let a0 = bal(&c, "alice.test");
    let r = challenge(&mut c, "bob.test", 1, 40_000, 9, 120, Some(ghost_score + 500));
    assert_eq!(r.status, Status::Refused);
    assert!(r.note.unwrap().contains("the replay of the submitted inputs scores"));
    assert!(bal(&c, "alice.test") > a0, "the ghost's owner kept the stake");
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.defended, g.forfeits), (0, 1), "a refused run is a forfeit, not a defence");
}

#[test]
#[should_panic(expected = "the input log's ticks must strictly increase")]
fn malformed_log_refused_at_submit() {
    let mut c = setup();
    ctx("bob.test", 1, 2_000, 3);
    let run = c.start_run(None, None, None, None);
    ctx("bob.test", 0, 3_000, 3);
    c.submit_run(run.id, vec![10, 10], 7);
}

#[test]
#[should_panic(expected = "too late")]
fn late_submit_refused() {
    let mut c = setup();
    ctx("bob.test", 1, 2_000, 3);
    let run = c.start_run(None, None, None, None);
    ctx("bob.test", 0, 2_000 + 91_000, 3);
    c.submit_run(run.id, vec![], 7);
}

/// Any number of challengers may race a ghost at once; the first to beat it takes the pot, and a
/// later winner whose run was already in flight gets their stake back (the pot is never paid twice).
#[test]
fn attack_two_challengers_cannot_race_a_duel_at_once() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("carol.test", 3 * NEAR, 39_000, 9);
    c.deposit();
    // Block randomness under which bob's autopilot beats the ghost.
    let target = c.get_ghost(1).unwrap().score;
    let byte = (12u8..200)
        .find(|b| {
            let mut m = vec![*b; 32];
            m.extend_from_slice(&c.next_run.to_le_bytes());
            m.extend_from_slice(b"bob.test");
            fly(&hex(&env::sha256(&m)), 24, 6, 3600).1 > target
        })
        .unwrap();
    ctx("bob.test", 1, 40_000, byte);
    let rb = c.start_run(Some(1), None, None, None);
    assert_eq!((c.get_ghost(1).unwrap().racing, c.get_ghost(1).unwrap().lock_run), (1, Some(rb.id)));
    // carol is named too, and is refused while bob is in flight: nothing of hers moves.
    let c0 = bal(&c, "carol.test");
    ctx("carol.test", 1, 41_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(1), None, None, None);
    });
    assert!(why.contains("a duel takes one race at a time"), "{why}");
    assert_eq!(bal(&c, "carol.test"), c0);
    // bob lands and takes the pot he started for, once.
    let (lb, sb) = fly(&rb.seed, 24, 6, 3600);
    ctx("bob.test", 0, 60_000, byte);
    let b = c.submit_run(rb.id, lb, sb).unwrap();
    assert_eq!(b.status, Status::Won, "{:?}", b.note);
    assert!(b.note.unwrap().contains("won its 1.000 NEAR pot"));
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.pot.0, g.beaten, g.racing, g.lock_run), (0, 1, 0, None));
    // The duel is free again, and beaten: carol is told there is no pot, not that it is busy.
    ctx("carol.test", 1, 61_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(1), None, None, None);
    });
    assert!(why.contains("this ghost has no pot"), "{why}");
}

/// A race that is never submitted holds a duel only until its deadline: the next challenger's
/// start_run closes it (a forfeit that pays the ghost) in the same call. No separate expire_run.
#[test]
fn a_stale_race_is_closed_by_the_next_challenger() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("carol.test", 3 * NEAR, 39_000, 9);
    c.deposit();
    ctx("bob.test", 1, 40_000, 11);
    let rb = c.start_run(Some(1), None, None, None);
    // Before bob's deadline carol is refused; a moment after it she is in, and bob's run is over.
    ctx("carol.test", 1, rb.deadline_ms, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(1), None, None, None);
    });
    assert!(why.contains("a duel takes one race at a time"), "{why}");
    let a0 = bal(&c, "alice.test");
    ctx("carol.test", 1, rb.deadline_ms + 1, 9);
    let rc = c.start_run(Some(1), None, None, None);
    let bob = c.get_run(rb.id).unwrap();
    assert_eq!(bob.status, Status::Expired);
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.forfeits, g.racing, g.lock_run), (1, 1, Some(rc.id)));
    assert_eq!(bal(&c, "alice.test") - a0, NEAR / 10 * 70 / 100, "bob's forfeit paid the ghost's owner");
}

#[test]
#[should_panic(expected = "that's your own ghost")]
fn cannot_challenge_own_ghost() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("alice.test", 1, 40_000, 9);
    c.start_run(Some(1), None, None, None);
}

#[test]
#[should_panic(expected = "your balance is")]
fn stake_needs_balance() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("dave.test", 1, 40_000, 9);
    c.start_run(Some(1), None, None, None);
}

#[test]
fn traded_ghost_pays_its_new_owner() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("alice.test", 1, 35_000, 9);
    c.nft_transfer(acc("erin.test"), "1".into(), None, None);
    assert_eq!(c.nft_token("1".into()).unwrap().owner_id, acc("erin.test"));
    challenge(&mut c, "bob.test", 1, 40_000, 9, 120, None);
    assert_eq!(bal(&c, "erin.test"), NEAR / 10 * 70 / 100);
    assert_eq!(c.nft_supply_for_owner(acc("erin.test")).0, 1);
    assert_eq!(c.nft_supply_for_owner(acc("alice.test")).0, 0);
}

#[test]
#[should_panic(expected = "only the ghost's owner can transfer it")]
fn only_owner_transfers() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("bob.test", 1, 35_000, 9);
    c.nft_transfer(acc("bob.test"), "1".into(), None, None);
}

#[test]
fn runner_mode_checks_runner_and_log_hash() {
    let mut c = setup();
    ctx("owner.test", 0, 1_500, 1);
    c.set_mode(ReplayMode::Runner);
    c.set_runners(vec![acc("runner.test")]);
    c.set_params(500, 2500, 2000, U128(MILLI * 10), 90, 300, 86_400, 100, U128(MILLI * 10));
    ctx("bob.test", 1, 2_000, 3);
    let run = c.start_run(None, None, None, None);
    let (log, score) = fly(&run.seed, 24, 6, 600);
    ctx("bob.test", 0, 20_000, 3);
    let r = c.submit_run(run.id, log.clone(), score).unwrap();
    assert_eq!(r.status, Status::Replaying);
    assert_eq!(c.pending_replays(None).len(), 1);
    let g = ghost_sim::replay(&unhex32(&run.seed), &log).unwrap();
    let job = |lh: String| JobResult { score: g.score(), metres: g.metres(), gems: g.gems, ticks: g.tick, survived: g.survived(), final_state_hash: hex(&env::sha256(&g.state_bytes())), log_hash: lh };
    ctx("mallory.test", 0, 21_000, 3);
    let why = expect_panic(|| {
        reopen(&mut c).submit_replay(run.id, job(log_hash(&log)));
    });
    assert!(why.contains("not a registered runner"), "{why}");
    ctx("runner.test", 0, 21_000, 3);
    let why = expect_panic(|| {
        reopen(&mut c).submit_replay(run.id, job(log_hash(&[5, 51])));
    });
    assert!(why.contains("a different log"), "{why}");
    let r = c.submit_replay(run.id, job(log_hash(&log)));
    assert_eq!(r.status, Status::Verified);
    assert!(r.replay.unwrap().via.contains("not a TEE"));
    assert_eq!(bal(&c, "runner.test"), MILLI * 10, "the runner got the replay fee (its balance entry's storage came from bob's reserve)");
    assert!(c.pending_replays(None).is_empty());
}

#[test]
fn withdraw_is_full_access_only() {
    let mut c = setup();
    ctx("bob.test", 0, 2_000, 3);
    let why = expect_panic(|| {
        let _ = reopen(&mut c).withdraw(None);
    });
    assert!(why.contains("Requires attached deposit of exactly 1 yoctoNEAR"), "{why}");
    ctx("bob.test", 1, 2_000, 3);
    let b = bal(&c, "bob.test");
    let _ = c.withdraw(Some(U128(NEAR)));
    assert_eq!(bal(&c, "bob.test"), b - NEAR);
}

// ---------------- the AI judge's findings, as attacks (each expected refusal or cost) ----------------

/// Finding 2 (best-of-N): a qualifier's pot is locked before its cave exists. One that falls short
/// costs `abandon_bps` of it; one that qualifies can't be retired until `pot_lock_secs` pass.
#[test]
fn attack_best_of_n_minting_costs_every_try() {
    let mut c = setup();
    let a0 = bal(&c, "alice.test");
    ctx("alice.test", 1, 2_000, 7);
    let run = c.start_run(None, q(NEAR, NEAR / 10), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 20); // a bad cave: gives up at once
    assert!(score < 100);
    ctx("alice.test", 0, 10_000, 7);
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Unqualified, "{:?}", r.note);
    let lost = a0 - bal(&c, "alice.test");
    assert!(lost >= NEAR / 5 && lost < NEAR / 5 + MILLI * 10, "a failed try costs 20% of the pot: {}", fmt_near(lost));
    // An abandoned (expired) qualifier costs the same.
    ctx("alice.test", 1, 20_000, 8);
    let run = c.start_run(None, q(NEAR, NEAR / 10), None, None);
    ctx("carol.test", 0, 20_000 + 91_000, 8);
    let r = c.expire_run(run.id);
    assert_eq!(r.status, Status::Expired);
    assert!(r.note.unwrap().contains("minus 0.200"));
    // A weak ghost that did qualify stays open to challengers: no quiet retirement.
    let (g, _) = mint_alice(&mut c);
    ctx("alice.test", 0, 50_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).retire_ghost(g.id);
    });
    assert!(why.contains("this pot is locked until"), "{why}");
    ctx("alice.test", 0, 50_000 + 86_400_000 + 31_000, 9);
    assert_eq!(c.retire_ghost(g.id).pot.0, 0, "after the lock, the owner can retire it");
}

/// Finding 3 (wash trading): 20 losses from the owner's own second account. They count as defences,
/// but the record shows the closest call (an obvious 7) and what the faking cost: 5% rake to the house
/// and 25% locked in the pot, where any challenger can win it, for at least a day.
#[test]
fn attack_wash_trade_shows_its_cost() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("alice-alt.test", 4 * NEAR, 40_000, 9);
    c.deposit();
    let both = |c: &GhostDuels| bal(c, "alice.test") + bal(c, "alice-alt.test");
    let start = both(&c);
    for i in 0..20u64 {
        ctx("alice-alt.test", 1, 40_000 + i * 1000, i as u8 + 10);
        let r = c.start_run(Some(1), None, None, None);
        ctx("alice-alt.test", 0, 40_500 + i * 1000, i as u8 + 10);
        c.submit_run(r.id, vec![], 7).unwrap(); // an instant honest loss
    }
    let g = c.get_ghost(1).unwrap();
    let cost = start - both(&c);
    assert_eq!(g.defended, 20);
    assert_eq!(g.best_challenge, 7, "the best losing challenge");
    assert_eq!(g.raked.0, 20 * NEAR / 10 * 5 / 100, "0.1 NEAR of rake");
    assert_eq!(g.grown.0, 20 * NEAR / 10 * 25 / 100, "0.5 NEAR now sits in the pot");
    assert!(cost >= g.raked.0 + g.grown.0, "out of the pair's pockets: {} (rake + pot growth {})", fmt_near(cost), fmt_near(g.raked.0 + g.grown.0));
    let md = c.nft_token("1".into()).unwrap().metadata.unwrap().description.unwrap();
    assert!(md.contains("best losing challenge 7") && md.contains("paid the house 0.100 NEAR"), "{md}");
    // Round 3: an alt can win the grown pot back, so the token makes no claim about what a fake costs.
    assert!(md.contains("can be faked") && !md.contains("costs at least"), "{md}");
    ctx("alice.test", 0, 70_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).retire_ghost(1);
    });
    assert!(why.contains("locked"), "the grown pot can't be pulled out right away: {why}");
}

/// Finding 4 (stolen session key): the thief mints a ghost with a 2 NEAR stake and plays the victim's
/// key against it. The key's cap (0.5 NEAR) refuses; a key with no cap can't stake at all.
#[test]
fn attack_stolen_session_key_is_capped() {
    let mut c = setup();
    ctx("thief.test", 3 * NEAR, 2_000, 3);
    c.deposit();
    ctx("thief.test", 1, 2_000, 3);
    let run = c.start_run(None, q(2 * NEAR, 2 * NEAR), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 900);
    ctx("thief.test", 0, 9_000, 3);
    let r = c.submit_run(run.id, log, score).unwrap();
    let gid = r.minted.unwrap();
    // bob's app key, never registered: refused outright.
    ctx_pk("bob.test", 0, 40_000, 4, Some(session_pk()));
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, None);
    });
    assert!(why.contains("this key has no spending cap"), "{why}");
    // bob registers it with a 0.5 NEAR cap, from his full-access key.
    ctx("bob.test", 1, 41_000, 4);
    c.set_key_cap(session_pk(), U128(NEAR / 2));
    let v0 = bal(&c, "bob.test");
    ctx_pk("bob.test", 0, 42_000, 4, Some(session_pk()));
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, None);
    });
    assert!(why.contains("this key's cap is 0.500 NEAR"), "{why}");
    assert_eq!(bal(&c, "bob.test"), v0, "the victim's balance is untouched");
    // A large qualifier pot through the key (the thief's other route) is refused outright since v4:
    // a staked qualifier names who may race it, which needs the account's full-access key (0019).
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, q(4 * NEAR, NEAR / 10), None, None);
    });
    assert!(why.contains("this key's cap") || why.contains("needs your full-access key"), "{why}");
    // Within the cap, the key plays.
    let r = c.start_run(None, None, None, None);
    assert_eq!(r.status, Status::Playing);
}

/// Finding 5 (an owner locking their own ghost): there are no locks any more (see
/// attack_relocking_a_ghost_never_blocks_a_challenger). An alt's abandoned challenges still cost: each
/// lapse is a forfeit (not a defence), paying the rake and the pot share.
#[test]
fn attack_abandoned_challenges_are_forfeits_and_cost() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("alice-alt.test", 2 * NEAR, 40_000, 9);
    c.deposit();
    let both = |c: &GhostDuels| bal(c, "alice.test") + bal(c, "alice-alt.test");
    let start = both(&c);
    let mut t = 40_000u64;
    for i in 0..6u8 {
        ctx("alice-alt.test", 1, t, i + 10);
        let r = c.start_run(Some(1), None, None, None);
        ctx("anyone.test", 0, t + 91_000, 1);
        c.expire_run(r.id);
        t += 92_000;
    }
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.defended, g.forfeits, g.racing), (0, 6, 0), "lapsed challenges are forfeits, not defences");
    let cost = start - both(&c);
    assert!(cost >= 6 * NEAR / 10 * 30 / 100, "six abandoned challenges cost the pair the rake and the pot share: {}", fmt_near(cost));
}

/// Finding 6 (storage): every path that grows state is paid. A first deposit pays for its entry; a
/// pending maximum-length log is paid at submit and refunded when it is dropped; settlement is paid
/// from the run's reserve.
#[test]
fn attack_storage_is_paid_on_every_path() {
    let mut c = setup();
    ctx("owner.test", 0, 1_500, 1);
    c.set_mode(ReplayMode::Runner);
    c.set_runners(vec![acc("runner.test")]);
    c.flush();
    let base = env::storage_usage();
    let byte = env::storage_byte_cost().as_yoctonear();
    let paid0 = c.paid_storage;
    ctx("newbie.test", NEAR, 2_000, 2);
    let b = c.deposit();
    assert!(b.0 < NEAR, "the first deposit paid for its balance entry");
    let p0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 3_000, 3);
    let run = c.start_run(None, None, None, None);
    ctx("bob.test", 0, 4_000, 3);
    let log: Vec<u32> = (0..2048).collect();
    c.submit_run(run.id, log, 0).unwrap();
    let p1 = bal(&c, "bob.test");
    assert!(p0 - p1 > 8_000 * byte, "bob paid for the 8 KB log he left pending");
    // Nobody replays it: anyone finishes it on-chain after the timeout; the log's storage comes back.
    ctx("carol.test", 0, 4_000 + 301_000, 3);
    let r = c.expire_run(run.id);
    assert!(r.replay.unwrap().via.starts_with("on-chain fallback"));
    assert!(bal(&c, "bob.test") - p1 > 7_000 * byte, "the log's storage came back when it was dropped (less what settling added)");
    c.flush();
    let used = (env::storage_usage() - base) as u128 * byte;
    assert!(c.paid_storage - paid0 >= used, "paid {} >= used {}", c.paid_storage - paid0, used);
}

/// Finding 7 (owner powers): the replay fee is capped, players can cap it per run, a run settles under
/// the rake it started with, and an arbitrary account set as "OutLayer" is never labelled a TEE.
#[test]
fn attack_owner_powers_are_bounded() {
    let mut c = setup();
    ctx("owner.test", 0, 1_500, 1);
    let why = expect_panic(|| reopen(&mut c).set_params(500, 2500, 2000, U128(MILLI * 60), 90, 300, 86_400, 100, U128(MILLI)));
    assert!(why.contains("replay fee at most 0.05 NEAR"), "{why}");
    let why = expect_panic(|| reopen(&mut c).set_params(500, 2500, 2000, U128(MILLI), 5, 300, 86_400, 100, U128(MILLI)));
    assert!(why.contains("run_secs between 65 and 600"), "{why}");
    let why = expect_panic(|| reopen(&mut c).set_params(2500, 2500, 2000, U128(MILLI), 90, 300, 86_400, 100, U128(MILLI)));
    assert!(why.contains("rake at most 20%"), "{why}");
    c.set_params(500, 2500, 2000, U128(MILLI * 20), 90, 300, 86_400, 100, U128(MILLI));
    ctx("bob.test", 1, 2_000, 3);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, None, Some(U128(MILLI * 10)), None);
    });
    assert!(why.contains("above your max_fee"), "{why}");
    mint_alice(&mut c);
    ctx("bob.test", 1, 40_000, 9);
    let run = c.start_run(Some(1), None, None, None);
    ctx("owner.test", 0, 41_000, 1);
    c.set_params(2000, 0, 2000, U128(MILLI * 20), 90, 300, 86_400, 100, U128(MILLI));
    let o0 = bal(&c, "owner.test");
    let (log, score) = fly(&run.seed, 24, 6, 120);
    ctx("bob.test", 0, 50_000, 9);
    c.submit_run(run.id, log, score).unwrap();
    assert_eq!(bal(&c, "owner.test") - o0, NEAR / 10 * 5 / 100, "the 5% in force at start_run, not 20%");
    ctx("owner.test", 0, 60_000, 1);
    c.set_outlayer(OutLayerConfig { contract: acc("evil.test"), wasm_url: "https://x.test/job.wasm".into(), wasm_hash: "ab".repeat(32), max_instructions: U64(1), max_execution_seconds: U64(1) });
    c.set_mode(ReplayMode::OutLayer);
    ctx("bob.test", 1, 61_000, 3);
    let run = c.start_run(None, None, None, None);
    let (log, score) = fly(&run.seed, 24, 6, 300);
    ctx("bob.test", 0, 62_000, 3);
    assert!(c.submit_run(run.id, log.clone(), score).is_none());
    let g = ghost_sim::replay(&unhex32(&run.seed), &log).unwrap();
    let out = json!({ "score": g.score(), "metres": g.metres(), "gems": g.gems, "ticks": g.tick, "survived": g.survived(), "final_state_hash": "00".repeat(32), "log_hash": log_hash(&log) });
    ctx_callback(63_000, PromiseResult::Successful(serde_json::to_vec(&out).unwrap()));
    let r = c.on_replay(run.id, Ok(Some(out)));
    assert_eq!(r.status, Status::Verified);
    let via = r.replay.unwrap().via;
    assert!(via.contains("not verified as a TEE"), "{via}");
}

/// Finding 8a: a known loser can't get a free refund by having the replay fail. Runner absent: after
/// the timeout anyone settles it on-chain, and the loss stands.
#[test]
fn attack_no_free_refund_for_a_known_loser() {
    let mut c = setup();
    mint_alice(&mut c);
    ctx("owner.test", 0, 30_500, 1);
    c.set_mode(ReplayMode::Runner);
    c.set_runners(vec![acc("runner.test")]);
    let b0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 40_000, 9);
    let run = c.start_run(Some(1), None, None, None);
    let (log, score) = fly(&run.seed, 24, 6, 120);
    ctx("bob.test", 0, 50_000, 9);
    c.submit_run(run.id, log, score).unwrap();
    ctx("bob.test", 0, 50_000 + 301_000, 9);
    let r = c.expire_run(run.id);
    assert_eq!(r.status, Status::Lost, "{:?}", r.note);
    assert!(b0 - bal(&c, "bob.test") >= NEAR / 10, "the stake is gone, not refunded");
}

/// Finding 8b: if OutLayer's `request_execution` itself fails, its attached fee comes back to the
/// contract and to the player; the run is replayed on-chain.
#[test]
fn attack_failed_outlayer_call_refunds_the_fee() {
    let mut c = setup();
    ctx("owner.test", 0, 1_500, 1);
    c.set_params(500, 2500, 2000, U128(MILLI * 20), 90, 300, 86_400, 100, U128(MILLI));
    c.set_outlayer(OutLayerConfig { contract: acc("outlayer.testnet"), wasm_url: "https://x.test/job.wasm".into(), wasm_hash: "ab".repeat(32), max_instructions: U64(1), max_execution_seconds: U64(1) });
    c.set_mode(ReplayMode::OutLayer);
    let b0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 2_000, 3);
    let run = c.start_run(None, None, None, None);
    let (log, score) = fly(&run.seed, 24, 6, 300);
    ctx("bob.test", 0, 3_000, 3);
    assert!(c.submit_run(run.id, log, score).is_none());
    assert!(c.get_run(run.id).unwrap().fee_spent, "the fee went with the request");
    ctx_callback(4_000, PromiseResult::Failed);
    let r = c.on_replay(run.id, Err(PromiseError::Failed));
    assert_eq!(r.status, Status::Verified, "replayed on-chain instead: {:?}", r.replay);
    assert!(r.replay.unwrap().via.contains("its fee came back"));
    assert!(b0 - bal(&c, "bob.test") < MILLI * 15, "the 0.02 fee was refunded (only storage kept): {}", fmt_near(b0 - bal(&c, "bob.test")));
}

/// Finding 8c: ghost ids past 2^32 used to alias ghost #1 (`as u32`).
#[test]
fn attack_ghost_ids_past_u32_dont_alias() {
    let mut c = setup();
    mint_alice(&mut c);
    assert!(c.get_ghost((1u64 << 32) + 1).is_none());
    assert!(c.nft_token(((1u64 << 32) + 1).to_string()).is_none());
    ctx("bob.test", 1, 40_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some((1u64 << 32) + 1), None, None, None);
    });
    assert!(why.contains("no such ghost"), "{why}");
}
// ---------------- property: money is conserved and storage is covered ----------------

/// Random play (qualifiers, challenges honest and edited, practice runs, expiries, the runner,
/// deposits, withdrawals) in OnChain and Runner modes. After every step the in-game ledger balances
/// to the NEAR that came in, and what players paid for storage covers every byte stored since setup.
#[test]
fn property_ledger_conserved_and_storage_covered_on_chain() {
    property(ReplayMode::OnChain);
}

#[test]
fn property_ledger_conserved_and_storage_covered_runner() {
    property(ReplayMode::Runner);
}

fn property(mode: ReplayMode) {
    {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rnd = move |n: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % n
        };
        ctx("owner.test", 0, 1_000, 1);
        let mut c = GhostDuels::new(acc("owner.test"), mode.clone(), true);
        c.set_runners(vec![acc("runner.test")]);
        c.set_params(500, 2500, 2000, U128(MILLI * 10), 90, 300, 3_600, 100, U128(MILLI * 10));
        c.flush();
        let base = env::storage_usage();
        let byte = env::storage_byte_cost().as_yoctonear();
        let players = ["p1.test", "p2.test", "p3.test", "owner.test", "runner.test"];
        let (mut deposited, mut withdrawn) = (0u128, 0u128);
        let mut t = 2_000u64;
        let mut open: Vec<(u64, Vec<u32>, u32)> = vec![];
        let mut settled = 0;
        for step in 0..200u64 {
            t += 500 + rnd(9_000);
            let p = players[rnd(3) as usize];
            match rnd(10) {
                0 | 1 => {
                    let amt = NEAR / 2 + rnd(3) as u128 * NEAR;
                    ctx(p, amt, t, step as u8);
                    c.deposit();
                    deposited += amt;
                }
                2..=4 => {
                    let n = c.ghosts.len() as u64;
                    let gid = if n > 0 && rnd(3) > 0 { Some(1 + rnd(n)) } else { None };
                    ctx(p, 1, t, step as u8); // q() names everyone but the player flying
                    let qual = if gid.is_none() && rnd(2) == 0 { q(NEAR / 5, NEAR / 50) } else { None };
                    if let Some(g) = gid.map(|g| c.get_ghost(g).unwrap()) {
                        // A duel takes one race at a time: skip one whose race is still in time
                        // (one past its deadline is closed by this start_run itself).
                        let busy = g.lock_run.is_some_and(|rid| t <= c.get_run(rid).unwrap().deadline_ms || c.get_run(rid).unwrap().status != Status::Playing);
                        if g.owner.as_str() == p || g.pot.0 == 0 || !g.challengers.contains(&acc(p)) || busy {
                            continue;
                        }
                    }
                    let need = c.get_ghost(gid.unwrap_or(0)).map_or(0, |g| g.stake.0) + qual.as_ref().map_or(0, |q| q.pot.0) + 3 * MILLI * 10 + (SETTLE_RESERVE_BYTES + GHOST_LOG_BYTES) as u128 * byte;
                    if bal(&c, p) < need {
                        continue;
                    }
                    ctx(p, 1, t, step as u8);
                    let r = c.start_run(gid, qual, None, None);
                    let quit = [60, 300, 900, 3600][rnd(4) as usize];
                    let (log, score) = fly(&r.seed, 24, 6, quit);
                    open.push((r.id, log, score));
                }
                5..=7 if !open.is_empty() => {
                    let (id, log, score) = open.remove(rnd(open.len() as u64) as usize);
                    let run = c.get_run(id).unwrap();
                    if run.status != Status::Playing {
                        continue;
                    }
                    let late = rnd(6) == 0;
                    let need = (log.len() as u128 * 4 + 400) * byte;
                    if late || t > run.deadline_ms || bal(&c, run.player.as_str()) < need {
                        t = t.max(run.deadline_ms + 1);
                        ctx("p3.test", 0, t, step as u8);
                        c.expire_run(id);
                    } else {
                        let claim = if rnd(5) == 0 { score + 1 } else { score };
                        ctx(run.player.as_str(), 0, t.min(run.deadline_ms), step as u8);
                        c.submit_run(id, log, claim);
                    }
                    settled += 1;
                }
                8 => {
                    for v in c.pending_replays(None) {
                        let id = v["run_id"].as_u64().unwrap();
                        let run = c.get_run(id).unwrap();
                        let log: Vec<u32> = serde_json::from_value(v["log"].clone()).unwrap();
                        if rnd(4) == 0 {
                            // The runner is away: anyone settles it on-chain after the timeout.
                            t = t.max(run.submitted_ms.unwrap() + 301_000);
                            ctx("p2.test", 0, t, step as u8);
                            c.expire_run(id);
                            continue;
                        }
                        let g = ghost_sim::replay(&unhex32(&run.seed), &log).unwrap();
                        ctx("runner.test", 0, t, step as u8);
                        c.submit_replay(id, JobResult { score: g.score(), metres: g.metres(), gems: g.gems, ticks: g.tick, survived: g.survived(), final_state_hash: "00".repeat(32), log_hash: run.log_hash.clone().unwrap() });
                    }
                }
                _ => {
                    let have = bal(&c, p);
                    if have > NEAR / 10 {
                        ctx(p, 1, t, step as u8);
                        let _ = c.withdraw(Some(U128(have / 3)));
                        withdrawn += have / 3;
                    }
                }
            }
            // balances + pots + what live runs hold + paid storage = deposits - withdrawals.
            let mut held: u128 = players.iter().map(|p| bal(&c, p)).sum();
            held += c.ghosts.iter().map(|g| g.pot.0).sum::<u128>();
            for id in 1..c.next_run {
                let r = c.get_run(id).unwrap();
                if matches!(r.status, Status::Playing | Status::Replaying) {
                    held += r.stake.0 + r.reserve.0 + r.qualify.as_ref().map_or(0, |q| q.pot.0) + if r.fee_spent { 0 } else { r.fee.0 };
                }
            }
            assert_eq!(held + c.paid_storage, deposited - withdrawn, "{mode:?} step {step}: the ledger doesn't balance");
            c.flush();
            let used = env::storage_usage().saturating_sub(base) as u128 * byte;
            assert!(c.paid_storage >= used, "{mode:?} step {step}: paid {} < used {}", c.paid_storage, used);
        }
        assert!(c.ghosts.len() >= 2 && settled >= 20, "{mode:?}: the sequence exercised the game: {} ghosts, {settled} runs closed", c.ghosts.len());
    }
}

// ---------------- the AI judge's second round (2026-11-06), as attacks ----------------

/// A run that flies but stays under `target`: a bot faking a near miss.
fn fly_under(seed: &str, target: u32) -> (Vec<u32>, u32) {
    let mut quit = 3600;
    loop {
        let (log, s) = fly(seed, 24, 6, quit);
        if s < target {
            return (log, s);
        }
        quit -= 10;
    }
}

/// Round 2, finding 2: discard caves at the minimum pot, then refill the keeper at once. A refill may
/// only restore the pot a ghost qualified with, so a big pot has to be risked on every try.
#[test]
fn attack_cheap_qualifier_then_refill_is_refused() {
    let mut c = setup();
    let min = MILLI * 10;
    ctx("alice.test", 1, 2_000, 99);
    let r = c.start_run(None, q(min, min), None, None);
    let (log, score) = fly(&r.seed, 24, 6, 3600);
    ctx("alice.test", 0, 30_000, 99);
    let gid = c.submit_run(r.id, log, score).unwrap().minted.unwrap();
    ctx("alice.test", 1, 31_000, 99);
    let why = expect_panic(|| {
        reopen(&mut c).refill_ghost(gid, U128(2 * NEAR));
    });
    assert!(why.contains("a refill only restores the pot it qualified with"), "{why}");
}

/// Round 2, finding 3: 20 near misses from the owner's alt, then the owner retires the ghost after
/// the lock. Each fake defence must cost at least the rake plus the pot share (30% of the stake),
/// which the NFT states.
#[test]
fn attack_wash_trade_near_misses_cost_what_the_record_says() {
    let mut c = setup();
    let (g0, _) = mint_alice(&mut c);
    ctx("alice-alt.test", 4 * NEAR, 40_000, 9);
    c.deposit();
    let both = |c: &GhostDuels| bal(c, "alice.test") + bal(c, "alice-alt.test");
    let start = both(&c) + c.get_ghost(1).unwrap().pot.0;
    for i in 0..20u64 {
        ctx("alice-alt.test", 1, 40_000 + i * 1000, i as u8 + 10);
        let r = c.start_run(Some(1), None, None, None);
        let (log, s) = fly_under(&r.seed, g0.score);
        ctx("alice-alt.test", 0, 40_500 + i * 1000, i as u8 + 10);
        c.submit_run(r.id, log, s).unwrap();
    }
    let md = c.nft_token("1".into()).unwrap().metadata.unwrap().description.unwrap();
    ctx("alice.test", 0, 40_000 + 86_400_000 + 60_000, 9);
    c.retire_ghost(1);
    let net = start - both(&c);
    assert!(net >= 20 * NEAR / 10 * 30 / 100, "20 fake defences cost the pair only {}", fmt_near(net));
    assert!(!md.contains("costs at least"), "no price claim on the token: {md}");
}

/// Round 2, finding 4: an alt that starts a challenge and never submits, again and again, must not
/// keep real challengers out.
#[test]
fn attack_holding_a_duel_needs_a_named_account_and_costs_every_time() {
    let mut c = setup();
    let gid = mint_named(&mut c, "alice.test", 2_000, 7, NEAR, NEAR / 10, &["alice-alt.test", "carol.test"]);
    for who in ["alice-alt.test", "carol.test", "stranger.test"] {
        deposit(&mut c, who, 10 * NEAR, 39_000);
    }
    // A stranger can't hold the duel at all: not named, refused, no lock.
    ctx("stranger.test", 1, 39_500, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, None);
    });
    assert!(why.contains("private duel"), "{why}");
    assert_eq!(c.get_ghost(gid).unwrap().lock_run, None);
    // The owner's own second account, which she named, can: it starts runs it never submits. Each
    // hold lasts until its deadline and no longer: carol's start_run a moment later closes it and
    // gets in, 10 times out of 10, and each hold costs the pair the rake and the pot share.
    let alt0 = bal(&c, "alice-alt.test");
    let mut t = 40_000u64;
    for i in 0..10u64 {
        ctx("alice-alt.test", 1, t, i as u8 + 10);
        let hold = c.start_run(Some(gid), None, None, None);
        ctx("carol.test", 1, hold.deadline_ms + 1, i as u8 + 60);
        let r = c.start_run(Some(gid), None, None, None);
        assert_eq!((r.status, c.get_run(hold.id).unwrap().status), (Status::Playing, Status::Expired));
        ctx("carol.test", 0, hold.deadline_ms + 5_000, 1);
        c.submit_run(r.id, vec![], 7).unwrap();
        t = hold.deadline_ms + 10_000;
    }
    let g = c.get_ghost(gid).unwrap();
    assert_eq!((g.forfeits, g.racing, g.lock_run), (10, 0, None));
    // Each hold forfeited a whole stake, of which the owner's own account got 70% back: the pair is
    // out the rake and the pot share, 30% of a stake, per hold (carol's own lost races aside).
    let forfeited = alt0 - bal(&c, "alice-alt.test");
    assert!(forfeited >= 10 * (NEAR / 10), "ten holds forfeited ten stakes: {}", fmt_near(forfeited));
    assert_eq!(g.raked.0 + g.grown.0, 20 * (NEAR / 10) * 30 / 100, "the rake and pot share of the 10 forfeits and carol's 10 refused runs");
}

/// Round 2, finding 5: a key capped at zero must not burn the balance on practice-run storage.
#[test]
fn attack_zero_cap_key_cannot_burn_the_balance() {
    let mut c = setup();
    ctx("bob.test", 1, 1_500, 4);
    c.set_key_cap(session_pk(), U128(0));
    ctx_pk("bob.test", 0, 2_000, 4, Some(session_pk()));
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, None, None, None);
    });
    assert!(why.contains("this key's cap"), "{why}");
}

/// Round 2, finding 1: a v3-style deploy is on-chain only. Its owner can't switch it to a runner or
/// to an OutLayer account, whose replays it would have to trust.
#[test]
fn attack_on_chain_only_deploy_refuses_offchain_replayers() {
    ctx("owner.test", 0, 1_000, 1);
    let mut c = GhostDuels::new(acc("owner.test"), ReplayMode::OnChain, false);
    for why in [
        expect_panic(|| reopen(&mut c).set_mode(ReplayMode::Runner)),
        expect_panic(|| reopen(&mut c).set_runners(vec![acc("owner-runner.test")])),
        expect_panic(|| reopen(&mut c).set_outlayer(OutLayerConfig { contract: acc("evil.test"), wasm_url: "https://x.test/j.wasm".into(), wasm_hash: "ab".repeat(32), max_instructions: U64(1), max_execution_seconds: U64(1) })),
    ] {
        assert!(why.contains("this deploy replays on-chain only"), "{why}");
    }
    let why = expect_panic(|| {
        GhostDuels::new(acc("owner.test"), ReplayMode::Runner, false);
    });
    assert!(why.contains("starts in OnChain mode"), "{why}");
}

/// A qualifier keeps the terms it started with: raising min_ghost_score mid-run can't turn it into
/// an abandon fee for the house.
#[test]
fn attack_owner_cannot_change_a_qualifier_mid_run() {
    let mut c = setup();
    ctx("alice.test", 1, 2_000, 7);
    let run = c.start_run(None, q(NEAR, NEAR / 10), None, None);
    ctx("owner.test", 0, 3_000, 1);
    c.set_params(500, 2500, 5000, U128(0), 90, 300, 30 * 86_400, 1000, U128(MILLI * 10));
    let (log, score) = fly(&run.seed, 24, 6, 900);
    ctx("alice.test", 0, 30_000, 7);
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Minted, "{:?}", r.note);
    assert_eq!(c.get_ghost(r.minted.unwrap()).unwrap().pot_locked_until_ms, 30_000 + 86_400_000, "the day's lock it started with");
}

// ---------------- the AI judge's third round (2026-11-06) ----------------

/// Round 3: the owner raised min_ghost_score just before a qualifier started and kept its abandon
/// fee. A qualifier may now state the terms it accepts, and min_ghost_score is capped.
#[test]
fn attack_owner_cannot_confiscate_a_qualifier_with_its_terms() {
    let mut c = setup();
    ctx("owner.test", 0, 1_500, 1);
    let why = expect_panic(|| reopen(&mut c).set_params(500, 2500, 2000, U128(0), 90, 300, 86_400, 100_000, U128(MILLI * 10)));
    assert!(why.contains("min_ghost_score at most 1000"), "{why}");
    c.set_params(500, 2500, 2000, U128(0), 90, 300, 86_400, 1000, U128(MILLI * 10));
    ctx("alice.test", 1, 2_000, 7);
    let terms = Some(Qualify { pot: U128(NEAR), stake: U128(NEAR / 10), max_min_score: Some(100), max_abandon_bps: Some(2000), challengers: named(&["bob.test"]) });
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, terms.clone(), None, None);
    });
    assert!(why.contains("above the most you accept"), "{why}");
}

/// Round 3: a beaten ghost whose pot regrew from an in-flight loser's stake (0.025) could be raced
/// at a 0.1 stake: a bet with no upside. Refused until its owner refills it.
#[test]
fn attack_ghost_with_pot_below_stake_cannot_be_raced() {
    let mut c = setup();
    mint_alice(&mut c);
    // On v3 a loser in flight beside a winner regrew a beaten ghost's pot to a quarter of a stake.
    // With one race at a time (0023) no call can leave a pot between zero and the stake any more;
    // the guard stays, so the state is set by hand here to show it still refuses.
    let mut g = c.get_ghost(1).unwrap();
    g.pot = U128(g.stake.0 / 4);
    c.put_ghost(g);
    ctx("dave.test", 3 * NEAR, 62_000, 1);
    c.deposit();
    ctx("dave.test", 1, 62_500, 1);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(1), None, None, None);
    });
    assert!(why.contains("pot is below its stake"), "{why}");
}

/// Round 3: the refundable settlement reserve counted as spent, so a 0.5 cap ran out after a few
/// challenges that lost far less. Only what a run can't get back counts.
#[test]
fn attack_key_cap_counts_losses_not_the_refunded_reserve() {
    let mut c = setup();
    ctx("bob.test", 1, 1_500, 4);
    c.set_key_cap(session_pk(), U128(MILLI * 30));
    for i in 0..3u64 {
        ctx_pk("bob.test", 0, 2_000 + i * 1000, (i + 1) as u8, Some(session_pk()));
        let r = c.start_run(None, None, None, None); // practice: only its own storage is lost
        c.submit_run(r.id, vec![], 7).unwrap();
    }
    let kc = c.get_key_cap(acc("bob.test"), session_pk()).unwrap();
    assert!(kc.spent.0 < MILLI * 30, "spent {}", fmt_near(kc.spent.0));
}

// ---------------- v4: private duels, the public ladder, and key caps that count all storage ----------------

/// Mint a ghost for `who` with an explicit list (full-access key) and return its id.
fn mint_named(c: &mut GhostDuels, who: &str, t: u64, seed: u8, pot: u128, stake: u128, list: &[&str]) -> u64 {
    ctx(who, 1, t, seed);
    let qual = Qualify { pot: U128(pot), stake: U128(stake), max_min_score: None, max_abandon_bps: None, challengers: if list.is_empty() { None } else { named(list) } };
    let run = c.start_run(None, Some(qual), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 900);
    ctx(who, 0, t + 20_000, seed);
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Minted, "{:?}", r.note);
    r.minted.unwrap()
}

fn deposit(c: &mut GhostDuels, who: &str, amount: u128, t: u64) {
    ctx(who, amount, t, 1);
    c.deposit();
}

/// 0019: a staked ghost is a private duel. A stranger (a bot that never was chosen) is refused; the
/// player its owner named gets in.
#[test]
fn attack_stranger_cannot_race_a_private_duel() {
    let mut c = setup();
    let gid = mint_named(&mut c, "alice.test", 2_000, 7, NEAR, NEAR / 10, &["bob.test"]);
    deposit(&mut c, "bot.test", 3 * NEAR, 30_000);
    let a0 = bal(&c, "alice.test");
    ctx("bot.test", 1, 40_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, None);
    });
    assert!(why.contains("this ghost is a private duel and its owner hasn't named you"), "{why}");
    assert_eq!(bal(&c, "alice.test"), a0, "nothing moved");
    let r = challenge(&mut c, "bob.test", gid, 41_000, 9, 120, None);
    assert_eq!(r.status, Status::Lost, "the named challenger races: {:?}", r.note);
}

/// 0019, guest-key sybils: twenty fresh accounts with capped session keys (what a bot gets from the
/// page's guest button, or the faucet) can't put money against a human who didn't name them. They
/// can't race a private duel, can't name challengers from a session key, and the public ladder they
/// can race moves no money.
#[test]
fn attack_guest_sybils_cannot_reach_staked_play() {
    let mut c = setup();
    let duel = mint_named(&mut c, "alice.test", 2_000, 7, NEAR, NEAR / 10, &["bob.test"]);
    let ladder = mint_named(&mut c, "alice.test", 30_000, 8, 0, 0, &[]);
    let a0 = bal(&c, "alice.test");
    let mut t = 60_000u64;
    for i in 0..20u32 {
        let sybil = format!("guest-{i}.testnet");
        deposit(&mut c, &sybil, NEAR / 2, t);
        ctx(&sybil, 1, t, 2);
        c.set_key_cap(session_pk(), U128(NEAR / 2));
        ctx_pk(&sybil, 0, t + 100, (i % 200) as u8 + 3, Some(session_pk()));
        let why = expect_panic(|| {
            reopen(&mut c).start_run(Some(duel), None, None, None);
        });
        assert!(why.contains("private duel"), "{why}");
        let why = expect_panic(|| {
            reopen(&mut c).start_run(None, Some(Qualify { pot: U128(NEAR / 10), stake: U128(NEAR / 100), max_min_score: None, max_abandon_bps: None, challengers: named(&["bob.test"]) }), None, None);
        });
        assert!(why.contains("needs your full-access key"), "{why}");
        let why = expect_panic(|| {
            reopen(&mut c).start_run(None, Some(Qualify { pot: U128(NEAR / 10), stake: U128(NEAR / 100), max_min_score: None, max_abandon_bps: None, challengers: None }), None, None);
        });
        assert!(why.contains("private duel: name 1 to 16 challengers"), "a staked ghost open to anyone is refused: {why}");
        // The public ladder: the sybil races alice's public ghost, and only its own storage moves.
        let s0 = bal(&c, &sybil);
        let r = c.start_run(Some(ladder), None, None, None);
        assert_eq!(r.stake.0, 0);
        ctx_pk(&sybil, 0, t + 5_000, 3, Some(session_pk()));
        let done = c.submit_run(r.id, vec![], 7).unwrap();
        assert!(done.note.unwrap().contains("no money moves"));
        assert!(s0 - bal(&c, &sybil) < MILLI * 10, "only the run's storage: {}", fmt_near(s0 - bal(&c, &sybil)));
        t += 10_000;
    }
    assert_eq!(bal(&c, "alice.test"), a0, "twenty sybils moved none of alice's money");
    let g = c.get_ghost(ladder).unwrap();
    assert_eq!((g.defended, g.pot.0, g.stake.0), (20, 0, 0));
}

/// 0019: the mutual-choice bypasses. A session key can't choose who races your money (a stolen key
/// naming the thief); nobody but the owner sets the list; a public ghost can't hold money; a list
/// can't be padded; a ghost passed to a new owner keeps the list its challengers chose to race, and
/// only that owner can change it.
#[test]
fn attack_mutual_choice_bypasses_are_refused() {
    let mut c = setup();
    let gid = mint_named(&mut c, "alice.test", 2_000, 7, NEAR, NEAR / 10, &["bob.test"]);
    // A stolen session key of alice's tries to add the thief to her ghost: set_challengers needs 1 yocto.
    ctx("alice.test", 1, 30_000, 2);
    c.set_key_cap(session_pk(), U128(NEAR));
    ctx_pk("alice.test", 0, 31_000, 2, Some(session_pk()));
    let why = expect_panic(|| {
        reopen(&mut c).set_challengers(gid, vec![acc("thief.test")]);
    });
    assert!(why.contains("Requires attached deposit of exactly 1 yoctoNEAR"), "{why}");
    // ... and can't mint a staked ghost of alice's money that names the thief.
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, Some(Qualify { pot: U128(NEAR / 2), stake: U128(NEAR / 10), max_min_score: None, max_abandon_bps: None, challengers: named(&["thief.test"]) }), None, None);
    });
    assert!(why.contains("needs your full-access key"), "{why}");
    // The thief's own full-access key can't touch alice's list.
    ctx("thief.test", 1, 32_000, 2);
    let why = expect_panic(|| {
        reopen(&mut c).set_challengers(gid, vec![acc("thief.test")]);
    });
    assert!(why.contains("not your ghost"), "{why}");
    // A public-ladder ghost holds no money and names nobody.
    ctx("carol.test", 1, 33_000, 2);
    for (pot, stake, list, expect) in [
        (NEAR / 10, NEAR / 100, None, "name 1 to 16 challengers"),
        (0, 0, named(&["bob.test"]), "a public-ladder ghost holds no money"),
        (NEAR / 10, NEAR / 100, Some(vec![acc("bob.test"), acc("bob.test")]), "name each challenger once"),
        (NEAR / 10, NEAR / 100, Some((0..17).map(|i| acc(&format!("p{i}.test"))).collect()), "name 1 to 16 challengers"),
    ] {
        let why = expect_panic(|| {
            reopen(&mut c).start_run(None, Some(Qualify { pot: U128(pot), stake: U128(stake), max_min_score: None, max_abandon_bps: None, challengers: list.clone() }), None, None);
        });
        assert!(why.contains(expect), "{why}");
    }
    deposit(&mut c, "carol.test", NEAR, 33_500);
    let ladder = mint_named(&mut c, "carol.test", 34_000, 8, 0, 0, &[]);
    ctx("carol.test", 1, 60_000, 2);
    let why = expect_panic(|| {
        reopen(&mut c).refill_ghost(ladder, U128(NEAR));
    });
    assert!(why.contains("a public-ladder ghost holds no money"), "{why}");
    let why = expect_panic(|| {
        reopen(&mut c).set_challengers(ladder, vec![acc("bob.test")]);
    });
    assert!(why.contains("a public-ladder ghost holds no money"), "{why}");
    // alice gives her ghost to erin: bob, who chose to race it, still may; erin replaces the list
    // with dave, and bob is out.
    ctx("alice.test", 1, 61_000, 2);
    c.nft_transfer(acc("erin.test"), gid.to_string(), None, None);
    assert_eq!(c.get_ghost(gid).unwrap().challengers, vec![acc("bob.test")]);
    deposit(&mut c, "erin.test", NEAR, 62_000);
    ctx("erin.test", 1, 63_000, 2);
    c.set_challengers(gid, vec![acc("dave.test")]);
    ctx("bob.test", 1, 64_000, 2);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, None);
    });
    assert!(why.contains("private duel"), "{why}");
    let tok = c.nft_token(gid.to_string()).unwrap().metadata.unwrap();
    assert!(tok.description.unwrap().contains("a private duel: only the 1 challengers its owner named"));
}

/// 0019: the public ladder. Anyone races it; a loss and a win count on the record and move no money.
#[test]
fn public_ladder_counts_the_record_and_moves_no_money() {
    let mut c = setup();
    // A session key may fly a public-ladder qualifier: there's no money in it to protect.
    // (Its cap must cover the recording's storage the run holds from the start, 0.103 NEAR: 0.2 here.)
    ctx("alice.test", 1, 1_500, 2);
    c.set_key_cap(session_pk(), U128(NEAR / 5));
    ctx_pk("alice.test", 0, 2_000, 7, Some(session_pk()));
    let run = c.start_run(None, q(0, 0), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 900);
    ctx_pk("alice.test", 0, 20_000, 7, Some(session_pk()));
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Minted, "{:?}", r.note);
    let gid = r.minted.unwrap();
    let g = c.get_ghost(gid).unwrap();
    assert_eq!((g.pot.0, g.stake.0, g.challengers.len()), (0, 0, 0));
    let (a0, h0) = (bal(&c, "alice.test"), bal(&c, "owner.test"));
    deposit(&mut c, "stranger.test", NEAR, 30_000);
    let lost = challenge(&mut c, "stranger.test", gid, 40_000, 9, 60, None);
    assert_eq!(lost.status, Status::Lost, "{:?}", lost.note);
    let won = challenge(&mut c, "bob.test", gid, 70_000, 11, 3600, None);
    assert_eq!(won.status, Status::Won, "{:?}", won.note);
    assert!(won.note.unwrap().contains("no money moves"));
    assert_eq!((bal(&c, "alice.test"), bal(&c, "owner.test")), (a0, h0), "no money moved to the owner or the house");
    let g = c.get_ghost(gid).unwrap();
    assert_eq!((g.defended, g.beaten, g.pot.0), (1, 1, 0));
    // Still raceable after it's beaten: a ladder rung, not a pot.
    ctx("carol.test", NEAR, 100_000, 1);
    c.deposit();
    ctx("carol.test", 1, 101_000, 4);
    assert_eq!(c.start_run(Some(gid), None, None, None).status, Status::Playing);
    let md = c.nft_token(gid.to_string()).unwrap().metadata.unwrap().description.unwrap();
    assert!(md.contains("on the public ladder"), "{md}");
}

/// A bug our AI review found (JUDGES.md row 7): a session key's cap must count every yocto its runs take from
/// the balance, storage included. v3 counted a run's start storage only: a qualifier's ghost-log
/// storage (submit_run) and settlement's storage came out of the balance uncounted. Now what the key
/// has spent equals, to the yocto, what the player's balance lost.
#[test]
fn attack_key_cap_counts_ghost_log_and_settlement_storage() {
    let mut c = setup();
    ctx("bob.test", 1, 1_500, 4);
    c.set_key_cap(session_pk(), U128(NEAR / 2));
    let spent = |c: &GhostDuels| c.get_key_cap(acc("bob.test"), session_pk()).unwrap().spent.0;
    // A public-ladder qualifier with a long log, through the key: its ghost's log is stored for good.
    let b0 = bal(&c, "bob.test");
    ctx_pk("bob.test", 0, 2_000, 5, Some(session_pk()));
    let run = c.start_run(None, q(0, 0), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 3600);
    assert!(log.len() > 300, "a long log: {}", log.len());
    ctx_pk("bob.test", 0, 60_000, 5, Some(session_pk()));
    assert_eq!(c.submit_run(run.id, log, score).unwrap().status, Status::Minted);
    assert_eq!(spent(&c), b0 - bal(&c, "bob.test"), "the key counts what the balance lost, the ghost's log and settlement included");
    // A staked challenge through the key, lost: the stake and every byte of storage.
    let gid = mint_named(&mut c, "alice.test", 70_000, 7, NEAR, NEAR / 10, &["bob.test"]);
    let (b1, s1) = (bal(&c, "bob.test"), spent(&c));
    ctx_pk("bob.test", 0, 100_000, 9, Some(session_pk()));
    let r = c.start_run(Some(gid), None, None, None);
    assert!(spent(&c) - s1 >= NEAR / 10 + SETTLE_RESERVE_BYTES_RACE as u128 * env::storage_byte_cost().as_yoctonear(), "while in flight, the key holds the stake and the reserve");
    let (log, score) = fly(&r.seed, 24, 6, 120);
    ctx_pk("bob.test", 0, 110_000, 9, Some(session_pk()));
    assert_eq!(c.submit_run(r.id, log, score).unwrap().status, Status::Lost);
    assert_eq!(spent(&c) - s1, b1 - bal(&c, "bob.test"), "settled: the key counts exactly the stake and the storage");
    // A qualifier whose recording wouldn't fit what's left of the cap is refused when it starts
    // (v4 refused it at submit, after the run was flown): the key holds the recording's storage
    // from start_run.
    let left = NEAR / 2 - spent(&c);
    ctx("bob.test", 1, 120_000, 4);
    c.set_key_cap(session_pk(), U128(spent(&c) + SETTLE_RESERVE_BYTES as u128 * env::storage_byte_cost().as_yoctonear() + 400 * env::storage_byte_cost().as_yoctonear()));
    assert!(left > 0);
    ctx_pk("bob.test", 0, 121_000, 6, Some(session_pk()));
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, q(0, 0), None, None);
    });
    assert!(why.contains("this key's cap"), "{why}");
}

/// #34: on v4 a qualifier paid for its recording at submit, so a player whose balance was close
/// to the pot flew a good run, was refused ("storing this ghost's log needs…") and forfeited 20%
/// of the pot when the run expired. Now the recording's storage is held from start_run: a start
/// the balance can't finish is refused before the cave exists, and a qualifier that started can
/// always be submitted, with what its log didn't use refunded.
#[test]
fn a_qualifier_that_can_start_can_always_submit() {
    ctx("owner.test", 0, 1_000, 1);
    let mut c = GhostDuels::new(acc("owner.test"), ReplayMode::OnChain, false);
    let byte = env::storage_byte_cost().as_yoctonear();
    let pot = NEAR / 20;
    let hold = (SETTLE_RESERVE_BYTES + GHOST_LOG_BYTES) as u128 * byte;
    // carol has the pot and the settlement reserve, as v4 asked, but not the recording's storage.
    deposit(&mut c, "carol.test", pot + SETTLE_RESERVE_BYTES as u128 * byte + 30 * MILLI, 1_100);
    ctx("carol.test", 1, 2_000, 7);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, Some(Qualify { pot: U128(pot), stake: U128(NEAR / 100), max_min_score: None, max_abandon_bps: None, challengers: named(&["bob.test"]) }), None, None);
    });
    assert!(why.contains("this run needs"), "{why}");
    // With it, she starts with almost nothing to spare, flies the longest log the autopilot makes,
    // and the submit goes through.
    deposit(&mut c, "carol.test", hold, 2_500);
    let c0 = bal(&c, "carol.test");
    ctx("carol.test", 1, 3_000, 7);
    let run = c.start_run(None, Some(Qualify { pot: U128(pot), stake: U128(NEAR / 100), max_min_score: None, max_abandon_bps: None, challengers: named(&["bob.test"]) }), None, None);
    assert_eq!(run.reserve.0, hold);
    assert!(bal(&c, "carol.test") < 50 * MILLI, "nearly everything is committed: {}", fmt_near(bal(&c, "carol.test")));
    let (log, score) = fly(&run.seed, 24, 6, 3600);
    assert!(log.len() > 300, "a long log: {}", log.len());
    let log_cost = (log.len() as u128 * 4 + 64) * byte;
    ctx("carol.test", 0, 60_000, 7);
    let r = c.submit_run(run.id, log, score).unwrap();
    assert_eq!(r.status, Status::Minted, "{:?}", r.note);
    // She is out the pot (now in her ghost), the recording and a little settlement and run storage.
    let out = c0 - bal(&c, "carol.test");
    assert!(out >= pot + log_cost && out < pot + log_cost + 15 * MILLI, "out {} for a {} pot and a {} recording", fmt_near(out), fmt_near(pot), fmt_near(log_cost));
}

/// The bound behind the fix: settlement never takes more storage than the run's reserve, even with
/// 64-character accounts and new balance entries for the house and the ghost's owner, so a key's cap
/// (which holds the reserve until settlement) is never overrun.
#[test]
fn settlement_storage_fits_in_the_reserve() {
    let long = |p: &str| format!("{p}{}", "x".repeat(64 - p.len() - 5)) + ".test";
    let (house, pilot, racer) = (long("house-"), long("pilot-"), long("racer-"));
    ctx(&house, 0, 1_000, 1);
    let mut c = GhostDuels::new(acc(&house), ReplayMode::OnChain, false);
    for who in [&pilot, &racer] {
        deposit(&mut c, who, 10 * NEAR, 1_000);
    }
    let byte = env::storage_byte_cost().as_yoctonear();
    let mut worst = (0u128, 0u128, 0u128);
    let mut settle = |c: &mut GhostDuels, who: &str, run: Run, log: Vec<u32>, claim: u32, t: u64| {
        ctx(who, 0, t, 1);
        c.flush();
        let u0 = env::storage_usage();
        let need = if run.qualify.is_some() { (log.len() as u128 * 4 + 64) * byte } else { 0 };
        let r = c.submit_run(run.id, log, claim).unwrap();
        c.flush();
        let grew = env::storage_usage().saturating_sub(u0) as u128 * byte;
        assert!(grew <= run.reserve.0, "{:?}: settlement took {} B, the reserve is {} B", r.status, grew / byte, run.reserve.0 / byte);
        let w = if run.qualify.is_some() { &mut worst.0 } else { &mut worst.1 };
        *w = (*w).max(grew - need);
        worst.2 = worst.2.max(grew);
        r
    };
    // A qualifier with the longest log the autopilot flies, minted (pilot's first ghost).
    ctx(&pilot, 1, 2_000, 21);
    let run = c.start_run(None, Some(Qualify { pot: U128(NEAR), stake: U128(NEAR / 10), max_min_score: None, max_abandon_bps: None, challengers: Some((0..16).map(|i| acc(&long(&format!("c{i:02}-")))).chain([acc(&racer)]).skip(1).collect()) }), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 3600);
    let r = settle(&mut c, &pilot.clone(), run, log, score, 60_000);
    assert_eq!(r.status, Status::Minted);
    let gid = r.minted.unwrap();
    // An unqualified qualifier: the house's first balance entry (its abandon fee).
    ctx(&pilot, 1, 70_000, 22);
    let run = c.start_run(None, Some(Qualify { pot: U128(NEAR), stake: U128(NEAR / 10), max_min_score: None, max_abandon_bps: None, challengers: named(&[racer.as_str()]) }), None, None);
    let (log, score) = fly(&run.seed, 24, 6, 20);
    assert_eq!(settle(&mut c, &pilot.clone(), run, log, score, 80_000).status, Status::Unqualified);
    // A lost challenge, a refused one, a won one; a practice run.
    for (t, quit, claim_more, expect) in [(100_000u64, 120u32, 0u32, Status::Lost), (200_000, 120, 500, Status::Refused), (300_000, 3600, 0, Status::Won)] {
        ctx(&racer, 1, t, (t / 1000) as u8);
        let run = c.start_run(Some(gid), None, None, None);
        let (log, score) = fly(&run.seed, 24, 6, quit);
        let r = settle(&mut c, &racer.clone(), run, log, score + claim_more, t + 30_000);
        if r.status != expect {
            assert_eq!(expect, Status::Won, "{:?}", r.note); // the strong autopilot may fall short on this cave
        }
    }
    ctx(&racer, 1, 400_000, 5);
    let run = c.start_run(None, None, None, None);
    let (log, score) = fly(&run.seed, 24, 6, 3600);
    assert_eq!(settle(&mut c, &racer.clone(), run, log, score, 430_000).status, Status::Verified);
    assert!(worst.0 <= SETTLE_RESERVE_BYTES as u128 * byte && worst.1 <= SETTLE_RESERVE_BYTES_RACE as u128 * byte);
    println!("worst settlement storage: qualifier {} B (reserve {}), race {} B (reserve {})", worst.0 / byte, SETTLE_RESERVE_BYTES, worst.1 / byte, SETTLE_RESERVE_BYTES_RACE);
}

/// Random play through one session key, the way a thief with a stolen key would: many runs in flight
/// at once (challenges of a ghost that names the victim, so the stakes go to the thief's ghost; public
/// qualifiers with long logs that burn storage; practice runs; refills), settled in random order by
/// the key, by its full-access key or by anyone after the deadline. After every step the key's spent
/// stays within its cap, and the victim's balance never lost more than the cap.
#[test]
fn property_a_session_key_never_loses_more_than_its_cap() {
    let mut x: u64 = 0xD1B5_4A32_D192_ED03;
    let mut rnd = move |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let mut c = setup();
    let cap = NEAR / 2;
    deposit(&mut c, "thief.test", 5 * NEAR, 1_100);
    let ghost = mint_named(&mut c, "thief.test", 1_200, 3, NEAR, NEAR / 20, &["bob.test"]);
    ctx("bob.test", 1, 30_000, 4);
    c.set_key_cap(session_pk(), U128(cap));
    let b0 = bal(&c, "bob.test");
    let spent = |c: &GhostDuels| c.get_key_cap(acc("bob.test"), session_pk()).unwrap().spent.0;
    let mut open: Vec<(u64, Vec<u32>, u32, u64)> = vec![];
    let mut t = 31_000u64;
    let (mut started, mut refused) = (0, 0);
    for step in 0..300u64 {
        t += 200 + rnd(3_000);
        match rnd(4) {
            0 | 1 => {
                // Start something through the key, if the cap allows (a refusal changes nothing).
                let (gid, qual) = match rnd(3) {
                    0 => (Some(ghost), None),
                    1 => (None, q(0, 0)),
                    _ => (None, None),
                };
                // A duel takes one race at a time. One still in time: refused, like any refusal. One
                // past its deadline start_run would close itself; here anyone closes it first, so
                // the probe below stays a pure refusal check (a probe must not change state).
                if let Some(rid) = gid.and_then(|g| c.get_ghost(g).unwrap().lock_run) {
                    if t <= c.get_run(rid).unwrap().deadline_ms {
                        refused += 1;
                        continue;
                    }
                    ctx("anyone.test", 0, t, 1);
                    c.expire_run(rid);
                }
                ctx_pk("bob.test", 0, t, step as u8, Some(session_pk()));
                let mut probe = reopen(&mut c);
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    probe.start_run(gid, qual.clone(), None, None);
                }))
                .is_err()
                {
                    refused += 1;
                    continue;
                }
                ctx_pk("bob.test", 0, t, step as u8, Some(session_pk()));
                let r = c.start_run(gid, qual, None, None);
                // The thief loses every challenge on purpose (the stake goes to his ghost).
                let quit = if gid.is_some() { 60 } else { [60, 900, 3600][rnd(3) as usize] };
                let (log, score) = fly(&r.seed, 24, 6, quit);
                open.push((r.id, log, score, r.deadline_ms));
                started += 1;
            }
            2 if !open.is_empty() => {
                let (id, log, score, deadline) = open.remove(rnd(open.len() as u64) as usize);
                if c.get_run(id).unwrap().status != Status::Playing {
                    continue; // closed already, by the next start_run on its duel
                }
                if rnd(5) == 0 || t > deadline {
                    t = t.max(deadline + 1);
                    ctx("anyone.test", 0, t, 1);
                    c.expire_run(id);
                } else {
                    // The key or bob's full-access key submits; a qualifier's log may not fit the cap.
                    let pk = if rnd(2) == 0 { Some(session_pk()) } else { None };
                    ctx_pk("bob.test", 0, t, 1, pk.clone());
                    let mut probe = reopen(&mut c);
                    let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        probe.submit_run(id, log.clone(), score);
                    }))
                    .is_ok();
                    if ok {
                        ctx_pk("bob.test", 0, t, 1, pk);
                        c.submit_run(id, log, score);
                    } else {
                        t = t.max(deadline + 1);
                        ctx("anyone.test", 0, t, 1);
                        c.expire_run(id);
                    }
                }
            }
            _ => {}
        }
        let s = spent(&c);
        assert!(s <= cap, "step {step}: the key's spent {} is over its cap", fmt_near(s));
        // What bob's balance is missing: settled losses plus what his live runs hold.
        let lost = b0.saturating_sub(bal(&c, "bob.test"));
        assert!(lost <= cap, "step {step}: bob lost {} through a {} cap", fmt_near(lost), fmt_near(cap));
    }
    for (id, _, _, deadline) in open.drain(..) {
        if c.get_run(id).unwrap().status != Status::Playing {
            continue;
        }
        ctx("anyone.test", 0, t.max(deadline + 1), 1);
        c.expire_run(id);
    }
    let lost = b0.saturating_sub(bal(&c, "bob.test"));
    assert!(lost <= spent(&c) && spent(&c) <= cap, "settled: bob lost {}, the key counts {}, cap {}", fmt_near(lost), fmt_near(spent(&c)), fmt_near(cap));
    assert!(started >= 30 && refused >= 5, "the sequence ran the key into its cap: {started} started, {refused} refused");
    // In flight, the runs' reserves held the rest of the cap; settled, the key counts exactly the loss.
    assert!(lost > cap / 2 && lost == spent(&c), "the thief got near the cap: lost {}, counted {}", fmt_near(lost), fmt_near(spent(&c)));
    println!("a stolen key, {started} runs started and {refused} refused: the victim lost {} of a {} cap (the key counts {})", fmt_near(lost), fmt_near(cap), fmt_near(spent(&c)));
}

/// 0022's hole, closed (docs/decisions/0023). On v4 a duel's owner could name a second account
/// while a challenger was in flight and have it win the pot first. Now the list can't change
/// mid-race, an account named beforehand can't start while the challenger races, and the ghost
/// can't be retired: the pot bob started for is there when he lands.
#[test]
fn attack_owner_cannot_take_the_pot_from_under_a_racing_challenger() {
    let mut c = setup();
    // alice names bob, and (in advance) a second account of her own.
    let gid = mint_named(&mut c, "alice.test", 2_000, 7, NEAR, NEAR / 10, &["bob.test", "alice-alt.test"]);
    deposit(&mut c, "alice-alt.test", 3 * NEAR, 30_000);
    let target = c.get_ghost(gid).unwrap().score;
    let seed_b = (12u8..250)
        .find(|b| {
            let mut m = vec![*b; 32];
            m.extend_from_slice(&c.next_run.to_le_bytes());
            m.extend_from_slice(b"bob.test");
            fly(&hex(&env::sha256(&m)), 24, 6, 3600).1 > target
        })
        .unwrap();
    let b0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 41_000, seed_b);
    let rb = c.start_run(Some(gid), None, None, None);
    let (log_b, score_b) = fly(&rb.seed, 24, 6, 3600);
    // While bob flies: alice can't change the list…
    ctx("alice.test", 1, 42_000, 1);
    let why = expect_panic(|| {
        reopen(&mut c).set_challengers(gid, vec![acc("bob.test"), acc("carol.test")]);
    });
    assert!(why.contains("a race is in flight"), "{why}");
    // …her second account can't start a race…
    ctx("alice-alt.test", 1, 43_000, 9);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, None);
    });
    assert!(why.contains("a duel takes one race at a time"), "{why}");
    // …and she can't retire the ghost, even past its pot lock.
    ctx("alice.test", 0, 44_000, 1);
    let why = expect_panic(|| {
        reopen(&mut c).retire_ghost(gid);
    });
    assert!(why.contains("locked until") || why.contains("in flight"), "{why}");
    // bob lands inside his deadline and takes the pot.
    ctx("bob.test", 0, 100_000, seed_b);
    let r = c.submit_run(rb.id, log_b, score_b).unwrap();
    assert_eq!(r.status, Status::Won);
    assert!(r.note.unwrap().contains("won its 1.000 NEAR pot"));
    assert!(bal(&c, "bob.test") - b0 > NEAR * 99 / 100, "bob has the pot (less his run's storage)");
    // Nobody names themselves as a challenger of their own ghost.
    ctx("alice.test", 1, 101_000, 1);
    let why = expect_panic(|| {
        reopen(&mut c).set_challengers(gid, vec![acc("alice.test")]);
    });
    assert!(why.contains("you can't race your own ghost"), "{why}");
    let why = expect_panic(|| {
        reopen(&mut c).start_run(None, Some(Qualify { pot: U128(NEAR / 5), stake: U128(NEAR / 20), max_min_score: None, max_abandon_bps: None, challengers: named(&["alice.test", "bob.test"]) }), None, None);
    });
    assert!(why.contains("you can't race your own ghost"), "{why}");
}

/// `withdraw`'s transfer can fail (the account was deleted before the NEAR arrived). v4 dropped
/// the amount; now the callback puts it back into the balance it left.
#[test]
fn a_failed_withdrawal_comes_back_to_the_balance() {
    let mut c = setup();
    let b0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 2_000, 1);
    let _ = c.withdraw(Some(U128(2 * NEAR)));
    assert_eq!(bal(&c, "bob.test"), b0 - 2 * NEAR);
    // The transfer succeeded: nothing comes back.
    ctx_callback(3_000, PromiseResult::Successful(vec![]));
    assert!(c.on_withdraw(acc("bob.test"), U128(2 * NEAR)));
    assert_eq!(bal(&c, "bob.test"), b0 - 2 * NEAR);
    // A second withdrawal whose transfer fails: the whole amount is back, and no storage was added.
    ctx("bob.test", 1, 4_000, 1);
    let _ = c.withdraw(None);
    assert_eq!(bal(&c, "bob.test"), 0);
    c.flush();
    let usage = env::storage_usage();
    ctx_callback(5_000, PromiseResult::Failed);
    assert!(!c.on_withdraw(acc("bob.test"), U128(b0 - 2 * NEAR)));
    assert_eq!(bal(&c, "bob.test"), b0 - 2 * NEAR);
    c.flush();
    assert_eq!(env::storage_usage(), usage);
}

/// A pot is the one term of a duel that can change after a challenger has read it: a second account
/// the owner named wins it, and a refill restores as little as the stake. Without `min_pot` the
/// challenger's start lands on the smaller pot and risks the same stake for it. With it, the start
/// is refused before anything is staked.
#[test]
fn attack_a_pot_swapped_for_a_smaller_one_is_refused_by_min_pot() {
    let mut c = setup();
    let gid = mint_named(&mut c, "alice.test", 2_000, 7, NEAR, NEAR / 10, &["bob.test", "alice-alt.test"]);
    deposit(&mut c, "alice-alt.test", 3 * NEAR, 30_000);
    let target = c.get_ghost(gid).unwrap().score;
    // bob reads the board: a 1 NEAR pot for a 0.1 stake. Then alice's second account wins the pot…
    let seed = (12u8..250)
        .find(|b| {
            let mut m = vec![*b; 32];
            m.extend_from_slice(&c.next_run.to_le_bytes());
            m.extend_from_slice(b"alice-alt.test");
            fly(&hex(&env::sha256(&m)), 24, 6, 3600).1 > target
        })
        .unwrap();
    let r = challenge(&mut c, "alice-alt.test", gid, 41_000, seed, 3600, None);
    assert_eq!(r.status, Status::Won);
    // …and alice refills it with a tenth of what bob saw.
    ctx("alice.test", 1, 70_000, 1);
    c.refill_ghost(gid, U128(NEAR / 10));
    let b0 = bal(&c, "bob.test");
    ctx("bob.test", 1, 71_000, 3);
    let why = expect_panic(|| {
        reopen(&mut c).start_run(Some(gid), None, None, Some(U128(NEAR)));
    });
    assert!(why.contains("below the 1.000 NEAR you were shown"), "{why}");
    assert_eq!(bal(&c, "bob.test"), b0, "nothing was staked");
    // The pot as it is now is his to accept.
    ctx("bob.test", 1, 72_000, 3);
    let run = c.start_run(Some(gid), None, None, Some(U128(NEAR / 10)));
    assert_eq!(run.status, Status::Playing);
}

/// A kept stake grows the pot and locks it for `pot_lock_secs` (a day). `retire_ghost` closes a race
/// that ran out of time itself, and that forfeit is growth like any other: the pot it grew can't be
/// retired in the same call (it was, before the lock was read after the forfeit).
#[test]
fn a_forfeit_closed_by_retire_locks_the_pot_like_any_other_growth() {
    let mut c = setup();
    mint_alice(&mut c);
    let day = 86_400_000;
    ctx("bob.test", 1, 2_000 + 2 * day, 11);
    let rb = c.start_run(Some(1), None, None, None);
    // bob never submits. Past his deadline (and past the ghost's first lock) alice retires.
    ctx("alice.test", 0, rb.deadline_ms + 1, 1);
    let why = expect_panic(|| {
        reopen(&mut c).retire_ghost(1);
    });
    assert!(why.contains("locked until"), "{why}");
    // Anyone closes bob's run; the pot grew and stays locked for a day from then.
    ctx("carol.test", 0, rb.deadline_ms + 2, 1);
    c.expire_run(rb.id);
    let g = c.get_ghost(1).unwrap();
    assert_eq!((g.forfeits, g.racing, g.lock_run), (1, 0, None));
    assert_eq!(g.pot_locked_until_ms, rb.deadline_ms + 2 + day);
    ctx("alice.test", 0, rb.deadline_ms + day, 1);
    let why = expect_panic(|| {
        reopen(&mut c).retire_ghost(1);
    });
    assert!(why.contains("locked until"), "{why}");
    let a0 = bal(&c, "alice.test");
    ctx("alice.test", 0, rb.deadline_ms + 2 + day, 1);
    c.retire_ghost(1);
    assert_eq!(bal(&c, "alice.test") - a0, NEAR, "the owner takes back the pot she put in; the grown part is the house's");
}
