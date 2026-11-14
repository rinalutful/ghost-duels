//! Every Ghost Duels path on a local NEAR sandbox (nearcore 2.14): free, offline, no faucet.
//! `cargo run` (from this directory) downloads NEAR's sandbox node once, deploys res/ghost_duels.wasm
//! and res/mock_outlayer.wasm, and then:
//!   1. ON-CHAIN REPLAY: the contract replays runs itself. Its final state hash must equal the
//!      wasip2 job's (under wasmtime) and this machine's native build: three builds, one answer.
//!      Prints the gas each replay costs.
//!   2. THE STORY (Runner mode, tonight's path): alice qualifies and mints ghost #1; bob challenges
//!      and loses (alice earns his stake minus the rake); bob challenges again and wins the pot; his
//!      winning run becomes ghost #2; ghost #1 is traded and its metadata shows its record.
//!   3. CHEATS: an edited score, a log that doesn't reproduce the claimed score, a malformed log,
//!      someone else's run, a replay from a non-runner, a runner replaying a different log.
//!   4. OUTLAYER (production shape, against a mock with real yield/resume): the request carries the
//!      job's URL and sha256; the "worker" (this program) runs the job under wasmtime and resolves;
//!      the yield resumes into `on_replay` and settles. A failed job and a timed-out yield both void
//!      the run and refund the stake.
//!   5. SESSION KEYS: a function-call key plays (start_run, submit_run) from the in-game balance, and
//!      can't withdraw, deposit or trade.
//!   6. EXPIRY: a challenge not submitted in time forfeits; the ghost is freed.
//! Every check prints ✓ or ✗; any ✗ exits 1. The Checks/call helpers are adapted from near-verdict's
//! sandbox (MIT, same author).
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::process::{Command, Stdio};

const RES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../res");

struct Checks(u32, u32);

impl Checks {
    fn check(&mut self, what: &str, ok: bool, detail: impl std::fmt::Display) {
        self.1 += 1;
        if !ok {
            self.0 += 1;
        }
        let d = detail.to_string();
        println!("{} {what:<72} {}", if ok { "✓" } else { "✗" }, if d.chars().count() > 120 { format!("{}…", d.chars().take(120).collect::<String>()) } else { d });
    }
}

type Res = Result<Value, String>;

async fn call(who: &Account, contract: &AccountId, method: &str, args: Value, deposit: NearToken, tgas: u64) -> anyhow::Result<Res> {
    let r = who.call(contract, method).args_json(args).deposit(deposit).gas(Gas::from_tgas(tgas)).transact().await?;
    Ok(outcome(r))
}

fn outcome(r: near_workspaces::result::ExecutionFinalResult) -> Res {
    if r.is_success() {
        Ok(r.json::<Value>().unwrap_or(Value::Null))
    } else {
        let why = format!("{:?}", r.failures());
        Err(why.split("Smart contract panicked: ").nth(1).map(|s| s.split('"').next().unwrap_or(s).to_string()).unwrap_or(why))
    }
}

fn refused(r: &Res, want: &str) -> bool {
    matches!(r, Err(m) if m.contains(want))
}

fn why(r: &Res) -> String {
    match r {
        Ok(v) => format!("accepted: {}", v.get("note").or(v.get("status")).unwrap_or(v)),
        Err(m) => m.clone(),
    }
}

async fn view(c: &AccountId, w: &Worker<Sandbox>, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(w.view(c, method).args_json(args).await?.json()?)
}

fn near(y: &Value) -> f64 {
    y.as_str().and_then(|s| s.parse::<u128>().ok()).unwrap_or(0) as f64 / 1e24
}

fn unhex32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

/// Fly a cave with a simple autopilot: aim for the middle of the cave `look` px ahead, leading by
/// `lead` ticks; give up (fly into the ceiling) at `quit` ticks. Returns (log, score).
fn fly(seed_hex: &str, look: i32, lead: i32, quit: u32) -> (Vec<u32>, u32) {
    let mut g = ghost_sim::Game::new(&unhex32(seed_hex));
    let mut log = vec![];
    while !g.done {
        let k = ((g.cam() + ghost_sim::SHIP_X + look) / ghost_sim::COL_W) as u32;
        let c = g.column(k).unwrap();
        let mid = (c.top as i32 + c.bot as i32) / 2 * ghost_sim::FP;
        let want = g.tick >= quit || g.y + g.vy * lead > mid;
        // The log holds at most MAX_TOGGLES changes; after that the button stays put (as in the browser).
        let want = if log.len() == ghost_sim::MAX_TOGGLES { g.held } else { want };
        if want != g.held {
            log.push(g.tick);
        }
        g.step(want);
    }
    (log, g.score())
}

/// Native replay (this machine's build of the same crate): (score, final_state_hash).
fn native(seed_hex: &str, log: &[u32]) -> (u32, String) {
    let g = ghost_sim::replay(&unhex32(seed_hex), log).unwrap();
    (g.score(), hex::encode(Sha256::digest(g.state_bytes())))
}

/// The replay job (res/ghost_replay_job.wasm, wasm32-wasip2) under wasmtime: what a runner or an
/// OutLayer worker runs.
fn job(seed_hex: &str, log: &[u32]) -> anyhow::Result<Value> {
    let mut p = Command::new("wasmtime")
        .args(["run", &format!("{RES}/ghost_replay_job.wasm")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("wasmtime: {e} (brew install wasmtime)"))?;
    p.stdin.take().unwrap().write_all(json!({ "seed": seed_hex, "log": log }).to_string().as_bytes())?;
    let out = p.wait_with_output()?;
    Ok(serde_json::from_slice(&out.stdout)?)
}

async fn now_ms(w: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(w.view_block().await?.timestamp() / 1_000_000)
}

/// Move the chain's clock forward by at least `secs`.
async fn advance(w: &Worker<Sandbox>, secs: u64) -> anyhow::Result<()> {
    let target = now_ms(w).await? + secs * 1000;
    while now_ms(w).await? < target {
        w.fast_forward(secs.max(10)).await?;
    }
    Ok(())
}

struct Game<'a> {
    w: &'a Worker<Sandbox>,
    id: AccountId,
    runner: &'a Account,
    /// Who every staked ghost here names as its challengers (a private duel, 0019): everyone but
    /// `stranger` (and, per ghost, but the player who flies it: nobody names themselves, 0023).
    named: Vec<AccountId>,
}

impl Game<'_> {
    /// From a full-access key: 1 yoctoNEAR marks the account itself (uncapped, 0010).
    async fn start(&self, who: &Account, ghost: Option<u64>) -> anyhow::Result<Res> {
        call(who, &self.id, "start_run", json!({ "ghost_id": ghost }), NearToken::from_yoctonear(1), 50).await
    }
    /// A qualifier: the pot and stake are locked before the cave exists (0009).
    async fn qualify(&self, who: &Account, pot_milli: u128, stake_milli: u128) -> anyhow::Result<Res> {
        let q = json!({ "pot": NearToken::from_millinear(pot_milli).as_yoctonear().to_string(), "stake": NearToken::from_millinear(stake_milli).as_yoctonear().to_string(), "challengers": self.named.iter().filter(|a| *a != who.id()).collect::<Vec<_>>() });
        call(who, &self.id, "start_run", json!({ "qualify": q }), NearToken::from_yoctonear(1), 50).await
    }
    async fn submit(&self, who: &Account, run: &Value, log: &[u32], claimed: u32) -> anyhow::Result<Res> {
        call(who, &self.id, "submit_run", json!({ "run_id": run["id"], "log": log, "claimed_score": claimed }), NearToken::from_yoctonear(0), 100).await
    }
    async fn run(&self, id: &Value) -> anyhow::Result<Value> {
        view(&self.id, self.w, "get_run", json!({ "run_id": id })).await
    }
    /// The resumed yield's callback lands a block or two after the worker's call: wait for it.
    async fn settled(&self, id: &Value) -> anyhow::Result<Value> {
        for _ in 0..40 {
            let r = self.run(id).await?;
            if r["status"] != "Replaying" {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        self.run(id).await
    }
    async fn ghost(&self, id: u64) -> anyhow::Result<Value> {
        view(&self.id, self.w, "get_ghost", json!({ "ghost_id": id })).await
    }
    async fn balance(&self, who: &Account) -> anyhow::Result<f64> {
        Ok(near(&view(&self.id, self.w, "get_balance", json!({ "account_id": who.id() })).await?))
    }
    /// The registered runner's job: replay every pending run with the wasip2 job, submit the result.
    async fn runner_pass(&self) -> anyhow::Result<Vec<Res>> {
        let pending = view(&self.id, self.w, "pending_replays", json!({})).await?;
        let mut out = vec![];
        for p in pending.as_array().unwrap() {
            let log: Vec<u32> = serde_json::from_value(p["log"].clone())?;
            let result = job(p["seed"].as_str().unwrap(), &log)?;
            out.push(call(self.runner, &self.id, "submit_replay", json!({ "run_id": p["run_id"], "result": result }), NearToken::from_yoctonear(0), 50).await?);
        }
        Ok(out)
    }
    /// Start, fly, submit, and (in Runner mode) let the runner settle. Returns (run view, log, score).
    async fn play(&self, who: &Account, ghost: Option<u64>, look: i32, lead: i32, quit: u32, runner: bool) -> anyhow::Result<(Value, Vec<u32>, u32)> {
        let run = self.start(who, ghost).await?.map_err(|e| anyhow::anyhow!("start_run: {e}"))?;
        self.fly_and_submit(who, run, look, lead, quit, runner).await
    }
    async fn play_q(&self, who: &Account, pot_milli: u128, stake_milli: u128, quit: u32, runner: bool) -> anyhow::Result<(Value, Vec<u32>, u32)> {
        let run = self.qualify(who, pot_milli, stake_milli).await?.map_err(|e| anyhow::anyhow!("start_run: {e}"))?;
        self.fly_and_submit(who, run, 24, 6, quit, runner).await
    }
    async fn fly_and_submit(&self, who: &Account, run: Value, look: i32, lead: i32, quit: u32, runner: bool) -> anyhow::Result<(Value, Vec<u32>, u32)> {
        let (log, score) = fly(run["seed"].as_str().unwrap(), look, lead, quit);
        self.submit(who, &run, &log, score).await?.map_err(|e| anyhow::anyhow!("submit_run: {e}"))?;
        if runner {
            self.runner_pass().await?;
        }
        Ok((self.run(&run["id"]).await?, log, score))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Everything that holds the sandbox lives inside run(), so the node stops before exit.
    // run() prints the result itself, before the node is stopped (a kill during cleanup can't hide it).
    let (failed, _total) = run().await?;
    std::process::exit(if failed == 0 { 0 } else { 1 });
}

async fn run() -> anyhow::Result<(u32, u32)> {
    let mut c = Checks(0, 0);
    let zero = NearToken::from_yoctonear(0);
    println!("Ghost Duels on a local sandbox\n");
    let w = near_workspaces::sandbox().await?;
    let gd: Contract = w.dev_deploy(&std::fs::read(format!("{RES}/ghost_duels.wasm"))?).await?;
    let mock: Contract = w.dev_deploy(&std::fs::read(format!("{RES}/mock_outlayer.wasm"))?).await?;
    let owner = w.dev_create_account().await?;
    let runner = w.dev_create_account().await?;
    let worker_op = w.dev_create_account().await?;
    let alice = w.dev_create_account().await?;
    let bob = w.dev_create_account().await?;
    let carol = w.dev_create_account().await?;
    let dave = w.dev_create_account().await?;
    let erin = w.dev_create_account().await?;
    let stranger = w.dev_create_account().await?;
    let id = gd.id().clone();
    // This instance may switch replay modes (the suite exercises all three); v3 on testnet may not.
    gd.call("new").args_json(json!({ "owner": owner.id(), "mode": "OnChain", "offchain_allowed": true })).transact().await?.into_result()?;
    let locked: Contract = w.dev_deploy(&std::fs::read(format!("{RES}/ghost_duels.wasm"))?).await?;
    locked.call("new").args_json(json!({ "owner": owner.id(), "mode": "OnChain", "offchain_allowed": false })).transact().await?.into_result()?;
    mock.call("new").args_json(json!({ "operator": worker_op.id() })).transact().await?.into_result()?;
    let g = Game { w: &w, id: id.clone(), runner: &runner, named: [&owner, &runner, &alice, &bob, &carol, &dave, &erin].iter().map(|a| a.id().clone()).collect() };
    let params = |fee: &str, run_secs: u64, timeout: u64| json!({ "rake_bps": 500, "pot_bps": 2500, "abandon_bps": 2000, "replay_fee": fee, "run_secs": run_secs, "replay_timeout_secs": timeout, "pot_lock_secs": 86_400, "min_ghost_score": 100, "min_stake": "10000000000000000000000" });
    call(&owner, &id, "set_params", params("0", 600, 600), zero, 30).await?.unwrap();
    let r = call(&owner, &id, "set_params", params("60000000000000000000000", 600, 600), zero, 30).await?;
    c.check("the owner can't set a replay fee above 0.05 NEAR", refused(&r, "replay fee at most"), why(&r));
    for p in [&alice, &bob, &carol, &dave, &erin] {
        call(p, &id, "deposit", json!({}), NearToken::from_near(5), 30).await?.unwrap();
    }
    let r = call(&stranger, &id, "set_mode", json!({ "mode": "Runner" }), zero, 30).await?;
    c.check("only the owner changes the replay mode", refused(&r, "only the owner"), why(&r));
    let r = call(&owner, locked.id(), "set_runners", json!({ "runners": [owner.id()] }), zero, 30).await?;
    c.check("an on-chain-only deploy (v3's) refuses even its owner's runner", refused(&r, "replays on-chain only"), why(&r));

    // ---- 1. On-chain replay: three builds, one answer ----
    println!("\n1. On-chain replay (the contract runs the same sim crate)");
    let mut max_tgas = 0f64;
    let mut agree = 0;
    let pilots = [(24, 6, 400), (16, 4, 1500), (32, 8, 2600), (24, 6, 3600), (40, 10, 3600)];
    for (i, (look, lead, quit)) in pilots.iter().enumerate() {
        let run = g.start(&alice, None).await?.unwrap();
        let seed = run["seed"].as_str().unwrap().to_string();
        let (log, score) = fly(&seed, *look, *lead, *quit);
        let r = alice.call(&id, "submit_run").args_json(json!({ "run_id": run["id"], "log": log, "claimed_score": score })).gas(Gas::from_tgas(300)).transact().await?;
        let gas = r.total_gas_burnt.as_gas() as f64 / 1e12;
        let replay_log = r.logs().iter().find(|l| l.starts_with("on-chain replay")).map(|s| s.to_string()).unwrap_or_default();
        let v = outcome(r);
        let chain = g.run(&run["id"]).await?;
        let (nscore, nhash) = native(&seed, &log);
        let j = job(&seed, &log)?;
        let same = v.is_ok() && chain["status"] == "Verified" && chain["replay"]["score"] == json!(nscore) && chain["replay"]["final_state_hash"] == json!(nhash)
            && j["final_state_hash"] == json!(nhash) && j["score"] == json!(nscore);
        if same {
            agree += 1;
        }
        let ticks = chain["replay"]["ticks"].as_u64().unwrap_or(0);
        max_tgas = max_tgas.max(gas);
        c.check(&format!("run {}: contract = wasip2 job = native ({} ticks, {} toggles)", i + 1, ticks, log.len()), same, format!("score {score}, {gas:.1} Tgas burnt in all; {replay_log}"));
    }
    c.check("the on-chain replay of a full 60 s run fits in one call", agree == pilots.len() && max_tgas < 300.0, format!("max {max_tgas:.1} Tgas of 300"));

    // ---- 2. The story, in Runner mode ----
    println!("\n2. The story (Runner mode: a registered runner replays with the wasip2 job under wasmtime)");
    call(&owner, &id, "set_mode", json!({ "mode": "Runner" }), zero, 30).await?.unwrap();
    call(&owner, &id, "set_runners", json!({ "runners": [runner.id()] }), zero, 30).await?.unwrap();
    call(&owner, &id, "set_params", params("10000000000000000000000", 600, 30), zero, 30).await?.unwrap();
    let (q, _qlog, qscore) = g.play_q(&alice, 1000, 200, 1200, true).await?;
    c.check("alice's qualifier (pot locked before the cave existed): the runner's replay verifies it", q["replay"]["via"].as_str().unwrap_or("").contains("not a TEE"), format!("{} · {}", q["note"], q["replay"]["via"]));
    let g1 = g.ghost(1).await?;
    c.check("…and it became ghost #1 by itself: 1 NEAR pot, 0.2 NEAR a challenge", q["status"] == "Minted" && g1["score"] == json!(qscore) && near(&g1["pot"]) == 1.0, format!("ghost #{} · {} pts", q["minted"], g1["score"]));
    let t = view(&id, &w, "nft_token", json!({ "token_id": "1" })).await?;
    c.check("ghost #1 is a NEP-171 token owned by alice", t["owner_id"] == alice.id().as_str() && t["metadata"]["title"].as_str().unwrap_or("").contains("pts"), t["metadata"]["title"].to_string());
    let a0 = g.balance(&alice).await?;
    let h0 = g.balance(&owner).await?;
    let (l, _, lscore) = g.play(&bob, Some(1), 24, 6, 300, true).await?;
    let a1 = g.balance(&alice).await?;
    let h1 = g.balance(&owner).await?;
    c.check("bob challenges ghost #1 and loses", l["status"] == "Lost", format!("{} vs {qscore}: {}", lscore, l["note"]));
    let pot1 = near(&g.ghost(1).await?["pot"]);
    c.check("the 0.2 stake splits: alice 0.14, the house 0.01, the pot +0.05", (a1 - a0 - 0.14).abs() < 1e-9 && (h1 - h0 - 0.01).abs() < 1e-9 && (pot1 - 1.05).abs() < 1e-9, format!("alice +{:.3}, house +{:.3}, pot {pot1:.3}", a1 - a0, h1 - h0));
    // The cave is the block's, so the autopilot sometimes crashes early: bob tries until he wins
    // (each miss is an ordinary loss), and the checks read the winning run.
    let mut tries = 0;
    let (mut b0, mut wrun, mut wlog, mut wscore);
    loop {
        tries += 1;
        b0 = g.balance(&bob).await?;
        (wrun, wlog, wscore) = g.play(&bob, Some(1), 24, 6, 3600, true).await?;
        if wrun["status"] == "Won" || tries == 6 {
            break;
        }
    }
    let b1 = g.balance(&bob).await?;
    c.check("bob challenges again and beats the ghost", wrun["status"] == "Won", format!("{wscore} vs {qscore}: {}", wrun["note"]));
    c.check("bob takes the grown pot (1.05 NEAR or more; net of his fee and storage)", b1 - b0 > 1.0, format!("bob +{:.4} after {tries} tries", b1 - b0));
    let g1 = g.ghost(1).await?;
    c.check("ghost #1's record: defended at least 1, beaten 1, pot 0", g1["defended"].as_u64().unwrap_or(0) >= 1 && g1["beaten"] == 1 && g1["pot"] == "0", format!("earned {:.3}", near(&g1["earned"])));
    let r = g.start(&carol, Some(1)).await?;
    c.check("a beaten ghost can't be challenged until its owner refills it", refused(&r, "no pot"), why(&r));
    let (b2, _, b2score) = g.play_q(&bob, 1000, 100, 3600, true).await?;
    c.check("bob flies a qualifier of his own: ghost #2, the new champion", b2["status"] == "Minted" && b2["minted"] == 2, format!("{b2score} pts · {}", b2["note"]));
    let r = call(&bob, &id, "retire_ghost", json!({ "ghost_id": 2 }), zero, 30).await?;
    c.check("a fresh ghost's pot can't be retired for a day (no mint-and-withdraw)", refused(&r, "locked until"), why(&r));
    let r = call(&alice, &id, "nft_transfer", json!({ "receiver_id": carol.id(), "token_id": "1" }), NearToken::from_yoctonear(1), 30).await?;
    let t = view(&id, &w, "nft_token", json!({ "token_id": "1" })).await?;
    c.check("alice sells ghost #1 to carol (nft_transfer, 1 yocto)", r.is_ok() && t["owner_id"] == carol.id().as_str(), why(&r));
    c.check("its metadata shows the record, and says a record can be faked", t["metadata"]["description"].as_str().unwrap_or("").contains("(best losing challenge") && t["metadata"]["description"].as_str().unwrap_or("").contains("can be faked"), t["metadata"]["description"].to_string());
    let r = call(&carol, &id, "refill_ghost", json!({ "ghost_id": 1, "amount": NearToken::from_millinear(500).as_yoctonear().to_string() }), NearToken::from_yoctonear(1), 30).await?;
    c.check("carol refills ghost #1's pot: it's open again", r.as_ref().map(|v| v["pot"] == NearToken::from_millinear(500).as_yoctonear().to_string()).unwrap_or(false), why(&r));
    let n = view(&id, &w, "nft_tokens_for_owner", json!({ "account_id": bob.id() })).await?;
    c.check("nft_tokens_for_owner(bob) lists ghost #2", n.as_array().map(|a| a.len() == 1 && a[0]["token_id"] == "2").unwrap_or(false), n.as_array().map_or(0, |a| a.len()));

    // ---- 3. Cheats ----
    println!("\n3. Cheats");
    let gh2 = g.ghost(2).await?;
    let ghost_score = gh2["score"].as_u64().unwrap() as u32;
    let r = call(&stranger, &id, "deposit", json!({}), NearToken::from_near(1), 30).await?;
    let r2 = g.start(&stranger, Some(2)).await?;
    c.check("a stranger (no one named them) can't race a staked ghost: it's a private duel", r.is_ok() && refused(&r2, "private duel"), why(&r2));
    let b0 = g.balance(&bob).await?;
    let run = g.start(&carol, Some(2)).await?.unwrap();
    let (log, real) = fly(run["seed"].as_str().unwrap(), 24, 6, 400);
    g.submit(&carol, &run, &log, ghost_score + 100).await?.unwrap();
    g.runner_pass().await?;
    let cr = g.run(&run["id"]).await?;
    c.check("an edited score (claims more than the replay) is refused", cr["status"] == "Refused", cr["note"].to_string());
    let pot_after = near(&g.ghost(2).await?["pot"]);
    c.check("…the stake is kept (the owner's 70%, the pot +25%), counted as a forfeit", g.balance(&bob).await? > b0 && (pot_after - near(&gh2["pot"]) - 0.025).abs() < 1e-9 && g.ghost(2).await?["forfeits"] == 1, format!("claimed {}, replay {real}; pot {pot_after:.3}", ghost_score + 100));
    let run = g.start(&carol, Some(2)).await?.unwrap();
    g.submit(&carol, &run, &wlog, wscore).await?.unwrap();
    g.runner_pass().await?;
    let cr = g.run(&run["id"]).await?;
    c.check("a winning log from another cave (wrong seed) doesn't reproduce its score", cr["status"] == "Refused", cr["note"].to_string());
    let run = g.start(&carol, None).await?.unwrap();
    let r = g.submit(&carol, &run, &[30, 20], 5).await?;
    c.check("a malformed log is refused at submit", refused(&r, "strictly increase"), why(&r));
    let r = g.submit(&dave, &run, &[], 7).await?;
    c.check("nobody can submit someone else's run", refused(&r, "not your run"), why(&r));
    let (log, score) = fly(run["seed"].as_str().unwrap(), 24, 6, 200);
    g.submit(&carol, &run, &log, score).await?.unwrap();
    let r = g.submit(&carol, &run, &log, score).await?;
    c.check("a run can't be submitted twice", refused(&r, "already submitted"), why(&r));
    let j = job(run["seed"].as_str().unwrap(), &log)?;
    let r = call(&stranger, &id, "submit_replay", json!({ "run_id": run["id"], "result": j }), zero, 50).await?;
    c.check("a replay from an account that isn't a registered runner is refused", refused(&r, "not a registered runner"), why(&r));
    let fake = job(run["seed"].as_str().unwrap(), &log[..log.len() - 1])?;
    let r = call(&runner, &id, "submit_replay", json!({ "run_id": run["id"], "result": fake }), zero, 50).await?;
    c.check("a runner can't settle a run with the replay of a different log", refused(&r, "different log"), why(&r));
    g.runner_pass().await?;
    c.check("…and the honest replay then verifies it", g.run(&run["id"]).await?["status"] == "Verified", "");

    // ---- 4. OutLayer, production shape, against the mock ----
    println!("\n4. OutLayer request_execution with yield/resume (SANDBOX MOCK of outlayer.testnet)");
    let job_hash = hex::encode(Sha256::digest(std::fs::read(format!("{RES}/ghost_replay_job.wasm"))?));
    let ol = json!({ "contract": mock.id(), "wasm_url": "https://github.com/rinalutful/ghost-duels/raw/main/res/ghost_replay_job.wasm", "wasm_hash": job_hash, "max_instructions": "2000000000", "max_execution_seconds": "20" });
    let r = call(&owner, &id, "set_mode", json!({ "mode": "OutLayer" }), zero, 30).await?;
    c.check("OutLayer mode needs its config first", refused(&r, "set_outlayer first"), why(&r));
    call(&owner, &id, "set_outlayer", json!({ "outlayer": ol }), zero, 30).await?.unwrap();
    call(&owner, &id, "set_mode", json!({ "mode": "OutLayer" }), zero, 30).await?.unwrap();
    call(&owner, &id, "set_params", params("20000000000000000000000", 600, 30), zero, 30).await?.unwrap();
    // A won challenge through OutLayer: dave vs ghost #2 would need a better run than bob's; use a
    // practice run, then a challenge of ghost #1 (carol's), which dave beats.
    let mut settled = vec![];
    for (who, ghost, quit) in [(&dave, None, 3600u32), (&dave, Some(1u64), 3600)] {
        let run = g.start(who, ghost).await?.unwrap();
        let (log, score) = fly(run["seed"].as_str().unwrap(), 24, 6, quit);
        let tx = who.call(&id, "submit_run").args_json(json!({ "run_id": run["id"], "log": log, "claimed_score": score })).gas(Gas::from_tgas(300)).transact_async().await?;
        // Play OutLayer's worker: wait for the request, check its source, run the job, resolve.
        let mut req = Value::Null;
        for _ in 0..40 {
            let p = view(mock.id(), &w, "pending", json!({})).await?;
            if let Some(x) = p.as_array().and_then(|a| a.first()) {
                req = x.clone();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let input: Value = serde_json::from_str(req["input_data"].as_str().unwrap_or("{}"))?;
        let src: Value = serde_json::from_str(req["source"].as_str().unwrap_or("{}"))?;
        c.check("the request pins the job by sha256, wasip2, and carries {seed, log}", src["WasmUrl"]["hash"] == json!(job_hash) && src["WasmUrl"]["build_target"] == "wasm32-wasip2" && input["seed"] == run["seed"], format!("request {} from {}, {:.3} NEAR attached", req["request_id"], req["sender_id"], near(&req["payment"])));
        let out = job(input["seed"].as_str().unwrap(), &serde_json::from_value::<Vec<u32>>(input["log"].clone())?)?;
        let r = call(&worker_op, mock.id(), "resolve_execution", json!({ "request_id": req["request_id"], "response": { "success": true, "output": { "Json": out }, "error": null } }), zero, 100).await?;
        let _ = tx.await?;
        let done = g.settled(&run["id"]).await?;
        settled.push(done["status"].clone());
        c.check(&format!("the worker resolves; the yield resumes into on_replay: {}", done["status"]), r.is_ok() && (done["status"] == "Verified" || done["status"] == "Won" || done["status"] == "Lost") && done["replay"]["via"].as_str().unwrap_or("").contains("OutLayer"), done["note"].to_string());
    }
    // A failed job: OutLayer returns null; the run is voided, the stake refunded.
    let d0 = g.balance(&dave).await?;
    let run = g.start(&dave, Some(2)).await?.unwrap();
    let (log, score) = fly(run["seed"].as_str().unwrap(), 24, 6, 500);
    let tx = dave.call(&id, "submit_run").args_json(json!({ "run_id": run["id"], "log": log, "claimed_score": score })).gas(Gas::from_tgas(300)).transact_async().await?;
    let mut rid = Value::Null;
    for _ in 0..40 {
        if let Some(x) = view(mock.id(), &w, "pending", json!({})).await?.as_array().and_then(|a| a.first().cloned()) {
            rid = x["request_id"].clone();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    call(&worker_op, mock.id(), "resolve_execution", json!({ "request_id": rid, "response": { "success": false, "output": null, "error": "instruction limit" } }), zero, 100).await?.unwrap();
    let _ = tx.await?;
    let v = g.settled(&run["id"]).await?;
    let d1 = g.balance(&dave).await?;
    c.check("a failed job comes back as null: the contract replays the log itself, the loss stands", v["status"] == "Lost" && v["replay"]["via"].as_str().unwrap_or("").starts_with("on-chain fallback"), format!("{} · {}", v["note"], v["replay"]["via"]));
    c.check("…no free refund: dave paid the 0.1 stake and the OutLayer fee", d0 - d1 > 0.12 && d0 - d1 < 0.13, format!("dave −{:.4} (stake 0.1 + fee 0.02 + storage)", d0 - d1));
    c.check("…and the ghost is free again", g.ghost(2).await?["racing"] == 0, "");
    // A yield nobody resolves: after ~200 blocks it times out, OutLayer's callback returns null.
    let run = g.start(&dave, None).await?.unwrap();
    let (log, score) = fly(run["seed"].as_str().unwrap(), 24, 6, 300);
    let tx = dave.call(&id, "submit_run").args_json(json!({ "run_id": run["id"], "log": log, "claimed_score": score })).gas(Gas::from_tgas(300)).transact_async().await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    w.fast_forward(250).await?;
    let mut v = Value::Null;
    for _ in 0..40 {
        v = g.run(&run["id"]).await?;
        if v["status"] != "Replaying" {
            break;
        }
        w.fast_forward(20).await?;
    }
    let _ = tx.await;
    c.check("a yield nobody resolves times out: on_replay gets null and replays it on-chain", v["status"] == "Verified" && v["replay"]["via"].as_str().unwrap_or("").starts_with("on-chain fallback"), format!("{} · {}", v["note"], v["replay"]["via"]));

    // ---- 5. Session keys ----
    // (The sandbox prices gas at 10x testnet, so the key's allowance is 1 NEAR here; 0.25 on testnet.)
    println!("\n5. Session keys (a function-call key that plays from the in-game balance)");
    call(&owner, &id, "set_mode", json!({ "mode": "Runner" }), zero, 30).await?.unwrap();
    call(&owner, &id, "set_params", params("10000000000000000000000", 600, 30), zero, 30).await?.unwrap();
    let sk = SecretKey::from_random(KeyType::ED25519);
    erin.batch(erin.id())
        .add_key(sk.public_key(), AccessKey::function_call_access(&id, &["start_run", "submit_run", "expire_run", "refill_ghost"], Some(NearToken::from_near(1))))
        .transact()
        .await?
        .into_result()?;
    let session = Account::from_secret_key(erin.id().clone(), sk.clone(), &w);
    let r = call(&session, &id, "start_run", json!({ "ghost_id": 2 }), zero, 50).await?;
    c.check("a session key with no spending cap can't stake", refused(&r, "no spending cap"), why(&r));
    let r = call(&erin, &id, "set_key_cap", json!({ "public_key": sk.public_key(), "cap": NearToken::from_millinear(250).as_yoctonear().to_string() }), NearToken::from_yoctonear(1), 30).await?;
    c.check("erin caps it at 0.25 NEAR from her full-access key", r.is_ok(), why(&r));
    let e0 = g.balance(&erin).await?;
    let wallet0 = erin.view_account().await?.balance;
    let run = call(&session, &id, "start_run", json!({ "ghost_id": 2 }), zero, 50).await?.map_err(|e| anyhow::anyhow!("session start_run: {e}"))?;
    let (s, _, _) = g.fly_and_submit(&session, run, 24, 6, 600, true).await?;
    let e1 = g.balance(&erin).await?;
    c.check("erin's app plays a challenge with the session key: no deposit, no prompt", s["status"] == "Lost" || s["status"] == "Won", format!("{} · in-game balance {e0:.3} → {e1:.3}", s["status"]));
    let wallet1 = erin.view_account().await?.balance;
    let gas_paid = (wallet0.as_yoctonear() as f64 - wallet1.as_yoctonear() as f64) / 1e24;
    c.check("the stake (and any winnings) moved the in-game balance; the wallet paid only gas", gas_paid < 0.01 && (e0 - e1).abs() > 0.09, format!("wallet {:+.5} (gas, net of refunds), in-game −{:.3} (stake + storage)", -gas_paid, e0 - e1));
    let r = call(&session, &id, "withdraw", json!({}), NearToken::from_yoctonear(1), 30).await;
    c.check("the session key can't withdraw (no deposits on a function-call key)", r.as_ref().map(|x| x.is_err()).unwrap_or(true), r.map(|x| why(&x)).unwrap_or_else(|e| format!("{e:?}").split("InvalidAccessKeyError").nth(1).unwrap_or("refused").chars().take(60).collect()));
    let r = call(&session, &id, "withdraw", json!({}), zero, 30).await;
    c.check("…nor without a deposit: withdraw isn't one of the key's methods", r.as_ref().map(|x| x.is_err()).unwrap_or(true), r.map(|x| why(&x)).unwrap_or_else(|e| format!("{e:?}").split("InvalidAccessKeyError").nth(1).unwrap_or("").chars().take(60).collect()));
    let r = call(&session, &id, "nft_transfer", json!({ "receiver_id": stranger.id(), "token_id": "2" }), zero, 30).await;
    c.check("…nor trade a ghost (method not on the key)", r.as_ref().map(|x| x.is_err()).unwrap_or(true), r.map(|x| why(&x)).unwrap_or_else(|e| format!("{e:?}").split("InvalidAccessKeyError").nth(1).unwrap_or("refused").chars().take(60).collect()));
    let r = call(&session, &id, "start_run", json!({ "qualify": { "pot": NearToken::from_millinear(500).as_yoctonear().to_string(), "stake": NearToken::from_millinear(100).as_yoctonear().to_string(), "challengers": [stranger.id()] } }), zero, 50).await?;
    c.check("…nor stake erin's money on a ghost naming who may race it (a thief naming himself)", refused(&r, "needs your full-access key"), why(&r));
    let kc = view(&id, &w, "get_key_cap", json!({ "account_id": erin.id(), "public_key": sk.public_key() })).await?;
    // In Runner mode the key also keeps counting the pending log's storage, which comes back to the
    // player when the log is dropped: it errs on the safe side, never under what the run took.
    c.check("the key counts at least what its run took from the balance, storage included", near(&kc["spent"]) >= e0 - e1 && near(&kc["spent"]) < 0.15, format!("spent {:.4} NEAR; the in-game balance lost {:.4}", near(&kc["spent"]), e0 - e1));
    call(&erin, &id, "set_key_cap", json!({ "public_key": sk.public_key(), "cap": NearToken::from_millinear(150).as_yoctonear().to_string() }), NearToken::from_yoctonear(1), 30).await?.unwrap();
    let r = call(&session, &id, "start_run", json!({ "ghost_id": 2 }), zero, 50).await?;
    c.check("past its cap (erin lowers it to 0.15) the key can't stake again: a thief's limit", refused(&r, "this key's cap is 0.150"), why(&r));
    let r = call(&erin, &id, "withdraw", json!({ "amount": NearToken::from_near(1).as_yoctonear().to_string() }), NearToken::from_yoctonear(1), 30).await?;
    c.check("erin's full-access key withdraws 1 NEAR", r.is_ok(), why(&r));

    // ---- 6. Expiry ----
    println!("\n6. Expiry");
    call(&owner, &id, "set_params", params("10000000000000000000000", 65, 30), zero, 30).await?.unwrap();
    let c0 = g.balance(&bob).await?;
    let run = g.start(&dave, Some(2)).await?.unwrap();
    let r = call(&stranger, &id, "expire_run", json!({ "run_id": run["id"] }), zero, 30).await?;
    c.check("a run can't be expired while it still has time", refused(&r, "still has time"), why(&r));
    advance(&w, 70).await?;
    let r = call(&stranger, &id, "expire_run", json!({ "run_id": run["id"] }), zero, 30).await?;
    let c1 = g.balance(&bob).await?;
    c.check("a challenge never submitted expires: bob (the ghost's owner) earns 70% of it", r.as_ref().map(|v| v["status"] == "Expired").unwrap_or(false) && (c1 - c0 - 0.07).abs() < 1e-9, format!("bob +{:.3}", c1 - c0));
    c.check("…counted as a forfeit, not a defence", g.ghost(2).await?["forfeits"].as_u64().unwrap_or(0) >= 1, g.ghost(2).await?["forfeits"].to_string());
    let run = g.start(&dave, None).await?.unwrap();
    let (log, score) = fly(run["seed"].as_str().unwrap(), 24, 6, 300);
    g.submit(&dave, &run, &log, score).await?.unwrap();
    advance(&w, 35).await?;
    let r = call(&stranger, &id, "expire_run", json!({ "run_id": run["id"] }), zero, 100).await?;
    c.check("a replay no runner delivers is done on-chain after the timeout, by anyone", r.as_ref().map(|v| v["status"] == "Verified" && v["replay"]["via"].as_str().unwrap_or("").starts_with("on-chain fallback")).unwrap_or(false), why(&r));

    // ---- 7. Solvency: the contract holds what it owes, and players paid for what it stores ----
    println!("\n7. Solvency");
    let acct = w.view_account(&id).await?;
    let mut owed = 0f64;
    for p in [&owner, &runner, &alice, &bob, &carol, &dave, &erin, &stranger] {
        owed += g.balance(p).await?;
    }
    for gid in 1..=view(&id, &w, "nft_total_supply", json!({})).await?.as_str().unwrap_or("0").parse::<u64>().unwrap_or(0) {
        owed += near(&g.ghost(gid).await?["pot"]);
    }
    let locked = acct.storage_usage as f64 * 1e19 / 1e24;
    let free = acct.balance.as_yoctonear() as f64 / 1e24 - locked;
    let st = view(&id, &w, "get_storage", json!({})).await?;
    c.check("free balance (after storage) covers every balance and pot", free >= owed, format!("free {free:.3} NEAR, owed {owed:.3} NEAR, storage {} B", acct.storage_usage));
    c.check("players have paid for storage", near(&st["paid"]) > 0.0, format!("paid {:.4} NEAR", near(&st["paid"])));

    let state = w.view_account(&id).await?;
    println!("\ncontract storage: {} bytes; ghosts minted: {}; settled through OutLayer: {:?}", state.storage_usage, view(&id, &w, "nft_total_supply", json!({})).await?, settled);
    let (failed, total) = (c.0, c.1);
    println!("{}", if failed == 0 { format!("\nAll {total} checks passed.") } else { format!("\n{failed} of {total} checks failed.") });
    Ok((failed, total))
}
