//! Ghost Duels: stake to beat a champion's recorded run (its "ghost") in a one-button cave flyer.
//!
//! The loop:
//!   1. A player keeps an in-game balance here (`deposit`). Their app then plays with a
//!      function-call key ("session key") that can only call the game's methods, so nothing pops up
//!      mid-game. It can spend that balance on stakes, never move it out (`withdraw` needs a
//!      full-access key), and only up to the cap the player set for that key (`set_key_cap`).
//!   2. `start_run` locks the stake (a challenge) or the pot (a qualifier: a run that will become a
//!      ghost) and only then draws the run's seed from the block's randomness, so nobody knows the
//!      cave before committing. The run must be submitted within `run_secs` (90 s for a 60 s game).
//!   3. The player flies; the client records the ticks at which the button changed.
//!   4. `submit_run(run_id, log, claimed_score)` stores the log's hash and asks for a replay, one of:
//!        - `OnChain`: the contract replays the log itself (the sim is integer-only and small);
//!        - `Runner`: a registered runner replays it with the wasm32-wasip2 job and calls
//!          `submit_replay` (the runner is trusted, it is NOT a TEE);
//!        - `OutLayer`: `request_execution` on OutLayer (yield/resume); a worker runs the same job
//!          and the result comes back to `on_replay`.
//!      A replay that never comes back, or comes back unusable, is done on-chain instead: no run is
//!      ever refunded because its replay failed, so a known loser can't buy a free retry.
//!   5. Settlement: a claimed score that differs from the replay is refused (and forfeits). A
//!      challenger who beats the ghost's score takes the pot and their stake back; otherwise the stake
//!      is split: the house's rake, a share that grows the ghost's pot (locked, at risk), the rest to
//!      the ghost's owner. A qualifier that scores at least `min_ghost_score` becomes a ghost with the
//!      pot it locked before its cave existed; otherwise it costs `abandon_bps` of that pot.
//!   6. Ghosts are NEP-171 NFTs whose metadata shows their record, and which can be traded (the buyer
//!      earns from then on).
//!
//! Every path that grows state charges the account that caused it, at the chain's storage price
//! (docs/decisions/0011). Owner powers are bounded and listed in the README.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PublicKey};

mod nft;
#[cfg(test)]
mod tests;

pub use nft::{NftContractMetadata, Token, TokenMetadata};

const GAS_ON_REPLAY: Gas = Gas::from_tgas(40);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(5);
const GAS_REQUEST_EXECUTION: Gas = Gas::from_tgas(80);

/// The most `set_params` can set a replay fee to (players can also cap it per run: `max_fee`).
pub const MAX_REPLAY_FEE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
/// Storage a run reserves for its settlement (its replay, note, new balance entries, a minted
/// ghost). What settlement doesn't use is refunded. A qualifier's ghost needs more room than a
/// challenge's or a practice run's settlement; `settlement_storage_fits_in_the_reserve` pins both
/// bounds, so a session key's cap (which holds the reserve while the run is in flight) is never
/// overrun by settlement.
pub const SETTLE_RESERVE_BYTES: u64 = 2_000;
pub const SETTLE_RESERVE_BYTES_RACE: u64 = 1_000;
/// Storage of the longest recording a ghost can keep (2,048 button changes, 4 bytes each, and its
/// key). A qualifier's reserve holds this too, from `start_run`: everything a run can need is
/// committed before its cave exists, so a qualifier that can start can always be submitted
/// (docs/decisions/0023; v4 took the recording's storage at submit, and a player without it
/// forfeited a good run). What the submitted log doesn't use is refunded with the reserve.
pub const GHOST_LOG_BYTES: u64 = ghost_sim::MAX_TOGGLES as u64 * 4 + 64;
/// The most challengers a private duel may name.
pub const MAX_CHALLENGERS: usize = 16;
/// The accounts whose `request_execution` is OutLayer's own. Replays from any other account set with
/// `set_outlayer` are labelled as unverified, never as a TEE.
pub const OUTLAYER_ACCOUNTS: [&str; 2] = ["outlayer.testnet", "outlayer.near"];

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Balances,
    Runs,
    Ghosts,
    GhostLogs,
    Pending,
    PendingLogs,
    KeyCaps,
}

/// Who replays a submitted run.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ReplayMode {
    /// The contract replays the log in the same transaction.
    OnChain,
    /// A registered runner replays it off-chain (the wasip2 job under wasmtime) and calls
    /// `submit_replay`. Trusted: the runner is an allowlisted account, not an attested enclave.
    Runner,
    /// OutLayer's `request_execution`: a worker runs the wasip2 job pinned by sha256, and the result
    /// resumes the yield into `on_replay`.
    OutLayer,
}

/// Where OutLayer finds the replay job, and the limits it runs under.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct OutLayerConfig {
    /// `outlayer.testnet` in production; the mock in the sandbox.
    pub contract: AccountId,
    /// An https URL of res/ghost_replay_job.wasm (a raw GitHub URL at a commit works once public).
    pub wasm_url: String,
    /// Its sha256, hex. The worker refuses other bytes.
    pub wasm_hash: String,
    pub max_instructions: U64,
    pub max_execution_seconds: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub mode: ReplayMode,
    /// Fixed at `new`. False: the deploy replays on-chain forever, and the owner can't switch it to a
    /// runner or OutLayer (whose replays it would have to trust). v3 is deployed with false.
    pub offchain_allowed: bool,
    /// Accounts allowed to call `submit_replay` (Runner mode).
    pub runners: Vec<AccountId>,
    pub outlayer: Option<OutLayerConfig>,
    /// The house's cut of a stake a ghost keeps, in basis points (500 = 5%; at most 20%).
    pub rake_bps: u16,
    /// The share of a kept stake that goes into the ghost's pot (2500 = 25%): the jackpot grows with
    /// every failed challenge, and an owner faking defences locks that share where anyone can win it.
    pub pot_bps: u16,
    /// What a qualifier that doesn't become a ghost costs, as a share of the pot it locked
    /// (2000 = 20%), so fishing for a lucky cave costs something every time.
    pub abandon_bps: u16,
    /// Charged per run from the player's balance: OutLayer's execution fee, or the runner's pay.
    /// At most `MAX_REPLAY_FEE`; a run is also refused if it exceeds the player's `max_fee`.
    pub replay_fee: U128,
    /// A run must be submitted this many seconds after it starts (65..=600), or it expires.
    pub run_secs: u64,
    /// A replay that hasn't come back after this many seconds is done on-chain instead (by anyone).
    pub replay_timeout_secs: u64,
    /// A ghost's pot can't be retired until this long after it was minted, refilled or grew.
    pub pot_lock_secs: u64,
    /// The least score a qualifier needs to become a ghost.
    pub min_ghost_score: u32,
    /// The least stake a ghost may ask.
    pub min_stake: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// Started; the player is flying.
    Playing,
    /// Submitted; waiting for the replay.
    Replaying,
    /// A practice run whose score the replay confirmed.
    Verified,
    /// A qualifier that became a ghost (`minted`).
    Minted,
    /// A qualifier below `min_ghost_score`: the pot came back minus `abandon_bps`.
    Unqualified,
    /// Beat the ghost: took the pot.
    Won,
    /// Didn't beat the ghost: its stake was kept.
    Lost,
    /// The claimed score didn't match the replay. Forfeits like a loss.
    Refused,
    /// Not submitted in time. Forfeits like a loss.
    Expired,
}

/// A qualifier's terms, fixed before its cave exists.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Qualify {
    /// Moves from the balance into the ghost (or back, minus `abandon_bps`).
    pub pot: U128,
    /// What each challenge of the ghost will cost.
    pub stake: U128,
    /// The most the qualifier accepts of the owner's terms, read when it starts (like `max_fee`):
    /// the score a ghost needs, and the abandon fee. Omitted: whatever is configured.
    #[serde(default)]
    pub max_min_score: Option<u32>,
    #[serde(default)]
    pub max_abandon_bps: Option<u16>,
    /// Who may race the ghost (docs/decisions/0019). A staked ghost (pot and stake) is a private
    /// duel and must name 1..=16 challengers, from the account's full-access key; a ghost with no
    /// pot and no stake is on the public ladder (anyone races it, no money moves) and names none.
    /// Moved onto the ghost when it is minted.
    #[serde(default)]
    pub challengers: Option<Vec<AccountId>>,
}

/// What a replay found. `via` says who ran it, in plain words.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Replay {
    pub score: u32,
    pub metres: u32,
    pub gems: u32,
    pub ticks: u32,
    pub survived: bool,
    pub final_state_hash: String,
    pub via: String,
}

/// The replay job's stdout (and `submit_replay`'s argument).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JobResult {
    pub score: u32,
    pub metres: u32,
    pub gems: u32,
    pub ticks: u32,
    pub survived: bool,
    pub final_state_hash: String,
    pub log_hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Run {
    pub id: u64,
    pub player: AccountId,
    /// The ghost this run challenges; none for a practice run or a qualifier.
    pub ghost: Option<u64>,
    /// Set for a qualifier: the run becomes a ghost with this pot and stake.
    pub qualify: Option<Qualify>,
    /// The cave's seed, hex: sha256(block random seed ‖ run id ‖ player).
    pub seed: String,
    pub stake: U128,
    pub fee: U128,
    /// The rake and pot share in force when the run started (later `set_params` don't apply).
    pub rake_bps: u16,
    pub pot_bps: u16,
    /// Likewise the qualifier's terms: its abandon fee, the score it needs, its ghost's pot lock.
    pub abandon_bps: u16,
    pub min_ghost_score: u32,
    pub pot_lock_secs: u64,
    /// Held for settlement's storage; the unused part is refunded.
    pub reserve: U128,
    pub started_ms: u64,
    pub deadline_ms: u64,
    pub status: Status,
    pub claimed_score: Option<u32>,
    /// sha256 of the log's canonical bytes (each tick as u32 little-endian), hex.
    pub log_hash: Option<String>,
    pub toggles: u32,
    pub submitted_ms: Option<u64>,
    pub replay: Option<Replay>,
    pub note: Option<String>,
    /// The ghost minted from this run, if any.
    pub minted: Option<u64>,
    /// True once the fee is settled: sent to OutLayer, paid to the runner, or (at the end, if neither
    /// earned it) refunded.
    pub fee_spent: bool,
    /// The capped session key that started the run, if any. Everything the run costs later (a
    /// qualifier's ghost log, settlement's storage) counts against that key's cap, whoever settles it.
    pub key: Option<PublicKey>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Ghost {
    pub id: u64,
    /// The NFT's owner: who earns when challengers lose.
    pub owner: AccountId,
    /// Who flew the run.
    pub pilot: AccountId,
    pub run: u64,
    pub seed: String,
    pub score: u32,
    pub metres: u32,
    pub gems: u32,
    pub ticks: u32,
    pub log_hash: String,
    /// What a challenger who beats it takes.
    pub pot: U128,
    /// What a challenge costs.
    pub stake: U128,
    /// Challengers who flew, were replayed and fell short.
    pub defended: u32,
    /// Challenges that forfeited without a valid flight (refused or expired): paid, not counted as
    /// defences.
    pub forfeits: u32,
    /// Challengers that beat it.
    pub beaten: u32,
    /// The best score a challenger flew against it and lost (the closest call).
    pub best_challenge: u32,
    /// What it has paid its owners (their share of kept stakes).
    pub earned: U128,
    /// What kept stakes added to its pot.
    pub grown: U128,
    /// What its kept stakes paid the house: a lower bound on what faking its record cost.
    pub raked: U128,
    /// The pot it qualified with: a refill may restore the pot up to this, never beyond (growth
    /// comes only from kept stakes).
    pub qualified_pot: U128,
    /// The part of the pot that came from kept stakes and hasn't been won: if the owner retires the
    /// ghost, this part goes to the house, so a faked defence costs its whole rake and pot share.
    pub grown_in_pot: U128,
    /// Challenges in flight. Any number may race a public-ladder ghost at once (docs/decisions/0015);
    /// a duel takes one at a time (`lock_run`, docs/decisions/0023).
    pub racing: u32,
    /// A staked ghost is a private duel: only these accounts may race it (its owner chose them with a
    /// full-access key, and each chose it by starting a run against it). Empty on a public-ladder
    /// ghost (no pot, no stake: anyone races it and no money moves). docs/decisions/0019.
    pub challengers: Vec<AccountId>,
    pub minted_ms: u64,
    /// `retire_ghost` is refused before this.
    pub pot_locked_until_ms: u64,
    /// A duel's one race in flight (docs/decisions/0023): while it is set nobody else can start a
    /// race against this ghost, its list can't change and it can't be retired, so the pot a
    /// challenger started for is still there when they land. Cleared when that run settles or
    /// expires; a run past its deadline is expired by the next call that needs the ghost. Always
    /// None on a public-ladder ghost.
    pub lock_run: Option<u64>,
}

/// How much a key may put at risk (stakes, qualifier pots, refills, fees and storage), and what it
/// has: `spent` is what its runs lost or hold in flight (a run's refundable reserve counts until the
/// run settles, then only the part settlement used).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyCap {
    pub cap: U128,
    pub spent: U128,
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    /// OutLayer's current signature (out-layer/outlayer contract/src/execution.rs, 7 arguments).
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct GhostDuels {
    config: Config,
    balances: LookupMap<AccountId, u128>,
    runs: LookupMap<u64, Run>,
    next_run: u64,
    ghosts: Vector<Ghost>,
    ghost_logs: LookupMap<u64, Vec<u32>>,
    /// Runs waiting for an off-chain replay, and their logs until settled.
    pending: IterableSet<u64>,
    pending_logs: LookupMap<u64, Vec<u32>>,
    key_caps: LookupMap<(AccountId, PublicKey), KeyCap>,
    /// Storage charged to players, net of refunds (yocto). Never less than what they use.
    paid_storage: u128,
}

pub(crate) fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    b.iter().flat_map(|x| [H[(x >> 4) as usize] as char, H[(x & 15) as usize] as char]).collect()
}

fn unhex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    require!(b.len() == 64, "a 32-byte hex value");
    let v = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => env::panic_str("not lowercase hex"),
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = v(b[2 * i]) << 4 | v(b[2 * i + 1]);
    }
    out
}

pub(crate) fn log_hash(log: &[u32]) -> String {
    let mut bytes = vec![0u8; ghost_sim::log_bytes_len(log)];
    ghost_sim::write_log_bytes(log, &mut bytes);
    hex(&env::sha256(&bytes))
}

/// NEAR to 3 decimals, rounded ("0.095", "1.000").
pub(crate) fn fmt_near(y: u128) -> String {
    let milli = (y + 500_000_000_000_000_000_000) / 1_000_000_000_000_000_000_000;
    format!("{}.{:03}", milli / 1000, milli % 1000)
}

fn bps(amount: u128, bps: u16) -> u128 {
    amount * bps as u128 / 10_000
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "ghost_duels", "version": "2.0.0", "event": event, "data": data })));
}

/// The index of ghost `id` (1-based) in the vector, refusing ids past u32 (which would alias).
pub(crate) fn ghost_index(id: u64) -> Option<u32> {
    id.checked_sub(1).and_then(|i| u32::try_from(i).ok())
}

#[near]
impl GhostDuels {
    #[init]
    pub fn new(owner: AccountId, mode: ReplayMode, offchain_allowed: bool) -> Self {
        require!(offchain_allowed || mode == ReplayMode::OnChain, "an on-chain-only deploy starts in OnChain mode");
        Self {
            config: Config {
                owner,
                mode,
                offchain_allowed,
                runners: vec![],
                outlayer: None,
                rake_bps: 500,
                pot_bps: 2500,
                abandon_bps: 2000,
                replay_fee: U128(0),
                run_secs: 90,
                replay_timeout_secs: 300,
                pot_lock_secs: 86_400,
                min_ghost_score: 100,
                min_stake: U128(NearToken::from_millinear(10).as_yoctonear()),
            },
            balances: LookupMap::new(Key::Balances),
            runs: LookupMap::new(Key::Runs),
            next_run: 1,
            ghosts: Vector::new(Key::Ghosts),
            ghost_logs: LookupMap::new(Key::GhostLogs),
            pending: IterableSet::new(Key::Pending),
            pending_logs: LookupMap::new(Key::PendingLogs),
            key_caps: LookupMap::new(Key::KeyCaps),
            paid_storage: 0,
        }
    }

    // ---------- owner settings (bounded; README "Owner powers") ----------

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.config.owner, "only the owner");
    }

    fn assert_offchain_allowed(&self) {
        require!(self.config.offchain_allowed, "this deploy replays on-chain only: no runners, no OutLayer");
    }

    pub fn set_mode(&mut self, mode: ReplayMode) {
        self.assert_owner();
        self.assert_offchain_allowed();
        if mode == ReplayMode::OutLayer {
            require!(self.config.outlayer.is_some(), "set_outlayer first");
        }
        self.config.mode = mode;
    }

    pub fn set_runners(&mut self, runners: Vec<AccountId>) {
        self.assert_owner();
        self.assert_offchain_allowed();
        require!(runners.len() <= 8, "at most 8 runners");
        self.config.runners = runners;
    }

    pub fn set_outlayer(&mut self, outlayer: OutLayerConfig) {
        self.assert_owner();
        self.assert_offchain_allowed();
        unhex32(&outlayer.wasm_hash);
        require!(outlayer.wasm_url.starts_with("https://") && outlayer.wasm_url.len() <= 300, "the job's URL must be https (and under 300 chars)");
        self.config.outlayer = Some(outlayer);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_params(&mut self, rake_bps: u16, pot_bps: u16, abandon_bps: u16, replay_fee: U128, run_secs: u64, replay_timeout_secs: u64, pot_lock_secs: u64, min_ghost_score: u32, min_stake: U128) {
        self.assert_owner();
        require!(rake_bps <= 2000, "rake at most 20%");
        require!(rake_bps as u32 + pot_bps as u32 <= 10_000, "rake and pot share at most 100% together");
        require!(abandon_bps <= 5000, "abandon fee at most 50%");
        require!(replay_fee.0 <= MAX_REPLAY_FEE, "replay fee at most 0.05 NEAR");
        require!((65..=600).contains(&run_secs), "run_secs between 65 and 600");
        require!((30..=3600).contains(&replay_timeout_secs), "replay_timeout_secs between 30 and 3600");
        require!(pot_lock_secs <= 30 * 86_400, "pot lock at most 30 days");
        require!(min_ghost_score <= 1000, "min_ghost_score at most 1000");
        require!(min_stake.0 > 0, "a stake can't be free");
        self.config = Config { rake_bps, pot_bps, abandon_bps, replay_fee, run_secs, replay_timeout_secs, pot_lock_secs, min_ghost_score, min_stake, ..self.config.clone() };
    }

    // ---------- balances, keys and storage ----------

    /// Add to your in-game balance (the one a session key spends). A first deposit pays for the
    /// balance's own storage out of what it brings.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let before = env::storage_usage();
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let b = self.credit(&who, amount);
        let cost = self.storage_since(before);
        require!(cost < b, "this deposit doesn't cover its own storage");
        self.balances.insert(who, b - cost);
        self.paid_storage += cost;
        U128(b - cost)
    }

    /// Take NEAR out of your balance (all of it if `amount` is omitted). Needs 1 yoctoNEAR attached,
    /// so only a full-access key can do it: a session key can't move money out. If the transfer
    /// fails (the account was deleted before it arrived), `on_withdraw` puts the amount back.
    #[payable]
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let have = self.balance(&who);
        let amount = amount.map_or(have, |a| a.0);
        require!(amount > 0 && amount <= have, "not that much in your balance");
        self.balances.insert(who.clone(), have - amount);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount + 1))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_WITHDRAW).on_withdraw(who, U128(amount)))
    }

    /// After `withdraw`'s transfer: if it failed, the amount goes back into the balance it left
    /// (whose entry `withdraw` kept, so this adds no storage). Returns whether the NEAR was sent.
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        self.credit(&account_id, amount.0);
        emit("withdraw_failed", json!({ "account_id": account_id, "amount": amount }));
        false
    }

    /// Set how much `public_key` (your app's session key) may put at risk in all: stakes, qualifier
    /// pots, refills and replay fees. Full-access only (1 yoctoNEAR). A key with no cap can't stake.
    #[payable]
    pub fn set_key_cap(&mut self, public_key: PublicKey, cap: U128) -> KeyCap {
        near_sdk::assert_one_yocto();
        let before = env::storage_usage();
        let who = env::predecessor_account_id();
        let k = (who.clone(), public_key);
        let spent = self.key_caps.get(&k).map_or(0, |c| c.spent.0);
        let kc = KeyCap { cap, spent: U128(spent) };
        self.key_caps.insert(k, kc.clone());
        let cost = self.storage_since(before);
        self.debit(&who, cost, "this key's storage");
        self.paid_storage += cost;
        kc
    }

    fn balance(&self, who: &AccountId) -> u128 {
        self.balances.get(who).copied().unwrap_or(0)
    }

    fn credit(&mut self, who: &AccountId, amount: u128) -> u128 {
        if amount == 0 {
            // Nothing to add (a public-ladder race, a 0 fee): don't create a balance entry for it.
            return self.balance(who);
        }
        let b = self.balance(who) + amount;
        self.balances.insert(who.clone(), b);
        b
    }

    fn debit(&mut self, who: &AccountId, amount: u128, what: &str) {
        let have = self.balance(who);
        if have < amount {
            env::panic_str(&format!("your balance is {} NEAR; {what} needs {} NEAR", fmt_near(have), fmt_near(amount)));
        }
        self.balances.insert(who.clone(), have - amount);
    }

    pub(crate) fn storage_cost_since(&mut self, before: u64) -> u128 {
        self.storage_since(before)
    }

    pub(crate) fn charge_storage(&mut self, who: &AccountId, cost: u128, what: &str) {
        self.debit(who, cost, what);
        self.paid_storage += cost;
    }

    /// Writes every collection out, then prices the storage added since `before` (0 if it shrank).
    fn storage_since(&mut self, before: u64) -> u128 {
        self.flush();
        env::storage_usage().saturating_sub(before) as u128 * env::storage_byte_cost().as_yoctonear()
    }

    fn flush(&mut self) {
        self.balances.flush();
        self.runs.flush();
        self.ghosts.flush();
        self.ghost_logs.flush();
        self.pending.flush();
        self.pending_logs.flush();
        self.key_caps.flush();
    }

    /// Spending through a session key is capped per key. A call with 1 yoctoNEAR attached (only a
    /// full-access key can attach a deposit) is the account itself, and uncapped.
    fn key_cap_entry(&self, who: &AccountId) -> Option<((AccountId, PublicKey), KeyCap)> {
        if env::attached_deposit().as_yoctonear() == 1 {
            return None;
        }
        require!(env::attached_deposit().is_zero(), "attach nothing, or 1 yoctoNEAR from a full-access key");
        require!(env::signer_account_id() == *who, "only the player's own keys can spend their balance");
        let k = (who.clone(), env::signer_account_pk());
        let kc = self.key_caps.get(&k).cloned().unwrap_or_else(|| {
            env::panic_str("this key has no spending cap: set one with set_key_cap from a full-access key, or attach 1 yoctoNEAR")
        });
        Some((k, kc))
    }

    fn check_key_cap(&self, who: &AccountId, amount: u128) {
        if let Some((_, kc)) = self.key_cap_entry(who) {
            if kc.spent.0 + amount > kc.cap.0 {
                env::panic_str(&format!("this key's cap is {} NEAR and it has put {} at risk; this needs {} more", fmt_near(kc.cap.0), fmt_near(kc.spent.0), fmt_near(amount)));
            }
        }
    }

    fn spend_from_key(&mut self, who: &AccountId, amount: u128) {
        self.check_key_cap(who, amount);
        if let Some((k, mut kc)) = self.key_cap_entry(who) {
            kc.spent = U128(kc.spent.0 + amount);
            self.key_caps.insert(k, kc);
        }
    }

    /// The capped key that is spending now (None: the account itself, with 1 yoctoNEAR attached).
    fn spending_key(&self, who: &AccountId) -> Option<PublicKey> {
        self.key_cap_entry(who).map(|((_, pk), _)| pk)
    }

    /// Count `amount` more against the cap of the key that started a run, whoever signs now (the
    /// player's full-access key, another key). Refused past the cap, before any state change.
    fn hold_on_run_key(&mut self, run: &Run, amount: u128) {
        let Some(pk) = run.key.clone() else { return };
        let k = (run.player.clone(), pk);
        let mut kc = self.key_caps.get(&k).cloned().unwrap_or_else(|| env::panic_str("the run's session key has no cap any more"));
        if kc.spent.0 + amount > kc.cap.0 {
            env::panic_str(&format!("this key's cap is {} NEAR and it has put {} at risk; this needs {} more", fmt_near(kc.cap.0), fmt_near(kc.spent.0), fmt_near(amount)));
        }
        kc.spent = U128(kc.spent.0 + amount);
        self.key_caps.insert(k, kc);
    }

    /// Settlement: the run's key stops holding the run's reserve (`held`) and is charged what
    /// settlement actually took from the player (`charged`). Never refused: a run always settles.
    fn release_run_key(&mut self, run: &Run, held: u128, charged: u128) {
        let Some(pk) = run.key.clone() else { return };
        let k = (run.player.clone(), pk);
        if let Some(mut kc) = self.key_caps.get(&k).cloned() {
            kc.spent = U128(kc.spent.0.saturating_sub(held) + charged);
            self.key_caps.insert(k, kc);
        }
    }

    /// A private duel's list: 1..=16 accounts (0 on `set_challengers` closes the duel), each once.
    fn check_challengers(list: &[AccountId], at_least: usize) {
        require!(list.len() >= at_least && list.len() <= MAX_CHALLENGERS, format!("a staked ghost is a private duel: name {at_least} to {MAX_CHALLENGERS} challengers (players who chose to race it), or qualify for the public ladder with no pot and no stake"));
        for (i, a) in list.iter().enumerate() {
            require!(!list[..i].contains(a), "name each challenger once");
        }
    }

    // ---------- runs ----------

    /// Start a run: a challenge of `ghost_id` (locks its stake), a qualifier (`qualify`: locks the pot
    /// it will become a ghost with), or a practice run (neither). The seed comes from this block's
    /// randomness, so the cave is unknown until now. `max_fee` refuses a replay fee above it;
    /// `min_pot` refuses a challenge whose ghost holds less than that now (the pot a challenger was
    /// shown can have been won and refilled smaller since: the stake is theirs to risk for the pot
    /// they state, not for whatever is there when the call lands).
    ///
    /// Staked play is a private duel (docs/decisions/0019): a staked ghost names its challengers, and
    /// only they may race it. A ghost with no pot and no stake is on the public ladder: anyone races
    /// it, and no money moves.
    #[payable]
    pub fn start_run(&mut self, ghost_id: Option<u64>, qualify: Option<Qualify>, max_fee: Option<U128>, min_pot: Option<U128>) -> Run {
        let player = env::predecessor_account_id();
        let id = self.next_run;
        self.next_run += 1;
        let now = env::block_timestamp_ms();
        let fee = self.config.replay_fee.0;
        if let Some(m) = max_fee {
            require!(fee <= m.0, format!("the replay fee is {} NEAR, above your max_fee", fmt_near(fee)));
        }
        // Checks first, then effects: nothing below panics after state has changed, except a balance
        // too small for the run's own storage (and a panic reverts the whole call on chain anyway).
        let mut stake = 0;
        let mut pot = 0;
        // A duel's one race in flight that ran out of time: this call closes it (below, once every
        // check has passed), so the next challenger never needs a separate expire_run.
        let mut stale = None;
        if let Some(gid) = ghost_id {
            require!(qualify.is_none(), "a run is a challenge or a qualifier, not both");
            let g = self.ghost(gid);
            require!(g.owner != player, "that's your own ghost");
            if let Some(m) = min_pot {
                require!(g.pot.0 >= m.0, format!("this ghost's pot is {} NEAR now, below the {} NEAR you were shown (min_pot): nothing was staked", fmt_near(g.pot.0), fmt_near(m.0)));
            }
            if g.stake.0 > 0 {
                require!(g.challengers.contains(&player), "this ghost is a private duel and its owner hasn't named you: staked races are only between players who chose each other (race a public-ladder ghost for free)");
                require!(g.pot.0 > 0, "this ghost has no pot (it was beaten); its owner can refill it");
                require!(g.pot.0 >= g.stake.0, "this ghost's pot is below its stake; its owner can refill it");
                stale = g.lock_run.filter(|rid| {
                    let r = self.run(*rid);
                    r.status == Status::Playing && now > r.deadline_ms
                });
                require!(g.lock_run.is_none() || stale.is_some(), "another challenger is racing this duel right now: a duel takes one race at a time, so the pot you start for is still there when you land. Try again when it lands (90 s at most)");
            }
            stake = g.stake.0;
        }
        if let Some(q) = &qualify {
            let named = q.challengers.as_deref().unwrap_or_default();
            if q.pot.0 == 0 && q.stake.0 == 0 {
                require!(named.is_empty(), "a public-ladder ghost holds no money, so it names no challengers: give it a pot and a stake to make it a private duel");
            } else {
                require!(q.stake.0 >= self.config.min_stake.0, format!("the stake must be at least {} NEAR", fmt_near(self.config.min_stake.0)));
                require!(q.pot.0 >= q.stake.0, "the pot must be at least the stake");
                Self::check_challengers(named, 1);
                require!(!named.contains(&player), "you can't race your own ghost: name the players who will");
                require!(env::attached_deposit().as_yoctonear() == 1, "choosing who may race your money needs your full-access key: attach 1 yoctoNEAR (a session key can't name challengers)");
            }
            if q.max_min_score.is_some_and(|m| self.config.min_ghost_score > m) || q.max_abandon_bps.is_some_and(|m| self.config.abandon_bps > m) {
                env::panic_str(&format!("the terms now are a {}-point minimum and a {}% abandon fee, above the most you accept", self.config.min_ghost_score, self.config.abandon_bps / 100));
            }
            pot = q.pot.0;
        }
        let reserve_bytes = if qualify.is_some() { SETTLE_RESERVE_BYTES + GHOST_LOG_BYTES } else { SETTLE_RESERVE_BYTES_RACE };
        let reserve = reserve_bytes as u128 * env::storage_byte_cost().as_yoctonear();
        let have = self.balance(&player);
        if have < stake + pot + fee + reserve {
            env::panic_str(&format!("your balance is {} NEAR; this run needs {} NEAR (stake or pot, fee, and a refundable storage reserve)", fmt_near(have), fmt_near(stake + pot + fee + reserve)));
        }
        // A session key's cap covers everything the run can take: stake or pot, fee, the run's own
        // storage (checked again below, once measured), and its settlement reserve, held until the
        // run settles; then the key keeps only what settlement used (`finish`).
        self.check_key_cap(&player, stake + pot + fee + reserve);
        let key = self.spending_key(&player);
        if let Some(rid) = stale {
            let b = env::storage_usage();
            self.expire(rid, b);
        }
        let before = env::storage_usage();
        if let Some(gid) = ghost_id {
            let mut g = self.ghost(gid);
            g.racing += 1;
            if g.stake.0 > 0 {
                g.lock_run = Some(id);
            }
            self.put_ghost(g);
        }
        let mut material = env::random_seed();
        material.extend_from_slice(&id.to_le_bytes());
        material.extend_from_slice(player.as_bytes());
        let run = Run {
            id,
            player: player.clone(),
            ghost: ghost_id,
            qualify,
            seed: hex(&env::sha256(&material)),
            stake: U128(stake),
            fee: U128(fee),
            rake_bps: self.config.rake_bps,
            pot_bps: self.config.pot_bps,
            abandon_bps: self.config.abandon_bps,
            min_ghost_score: self.config.min_ghost_score,
            pot_lock_secs: self.config.pot_lock_secs,
            reserve: U128(reserve),
            started_ms: now,
            deadline_ms: now + self.config.run_secs * 1000,
            status: Status::Playing,
            claimed_score: None,
            log_hash: None,
            toggles: 0,
            submitted_ms: None,
            replay: None,
            note: None,
            minted: None,
            fee_spent: false,
            key,
        };
        self.runs.insert(id, run.clone());
        let storage = self.storage_since(before);
        self.spend_from_key(&player, stake + pot + fee + storage + reserve);
        self.paid_storage += storage;
        let what = if ghost_id.is_some() { "this challenge (stake, fee, storage)" } else if pot > 0 { "this qualifier (pot, fee, storage)" } else { "a run (fee and storage)" };
        self.debit(&player, stake + pot + fee + storage + reserve, what);
        emit("run_started", json!({ "run_id": id, "player": player, "ghost_id": ghost_id, "seed": run.seed, "stake": run.stake, "pot": U128(pot) }));
        run
    }

    /// Submit a run: the ticks at which the button changed, and the score your client computed.
    /// The contract keeps the log's hash and asks for a replay; the replay's score decides.
    pub fn submit_run(&mut self, run_id: u64, log: Vec<u32>, claimed_score: u32) -> Option<Run> {
        let before = env::storage_usage();
        let mut run = self.run(run_id);
        require!(run.player == env::predecessor_account_id(), "not your run");
        require!(run.status == Status::Playing, "this run was already submitted or settled");
        require!(env::block_timestamp_ms() <= run.deadline_ms, "too late: the run expired");
        if let Err(e) = ghost_sim::check_log(&log) {
            env::panic_str(e.as_str());
        }
        run.status = Status::Replaying;
        run.claimed_score = Some(claimed_score);
        run.log_hash = Some(log_hash(&log));
        run.toggles = log.len() as u32;
        run.submitted_ms = Some(env::block_timestamp_ms());
        emit("run_submitted", json!({ "run_id": run_id, "claimed_score": claimed_score, "log_hash": run.log_hash, "mode": self.config.mode }));
        if self.config.mode == ReplayMode::OnChain {
            // A qualifier's log becomes the ghost's. Its storage was reserved at start_run
            // (GHOST_LOG_BYTES), on the balance and on the key that started the run, so nothing more
            // is asked for here: this submit can't fail for want of balance.
            self.runs.insert(run.id, run.clone());
            let replay = Self::replay_on_chain(&run, &log, "on-chain: this contract replayed the log");
            self.settle(run.id, replay, Some(log), before);
            return Some(self.run(run.id));
        }
        // Off-chain replay: the log waits here (paid by the player) so anyone can finish the run
        // on-chain if the replay never comes back.
        self.pending.insert(run.id);
        self.pending_logs.insert(run.id, log.clone());
        if self.config.mode == ReplayMode::OutLayer {
            run.fee_spent = true;
        }
        self.runs.insert(run.id, run.clone());
        let cost = self.storage_since(before);
        // The pending log's storage counts against the key that started the run (refunded to the
        // player when the log is dropped; the key keeps counting it, which only errs on the safe side).
        self.hold_on_run_key(&run, cost);
        self.debit(&run.player, cost, "keeping the log until its replay");
        self.paid_storage += cost;
        if self.config.mode == ReplayMode::Runner {
            emit("replay_requested", json!({ "run_id": run_id, "seed": run.seed, "log_hash": run.log_hash }));
            return Some(run);
        }
        let o = self.config.outlayer.clone().unwrap_or_else(|| env::panic_str("OutLayer is not configured"));
        let input = json!({ "seed": run.seed, "log": log }).to_string();
        // Not returned: the Promise is scheduled when dropped, and this call answers None. If
        // request_execution itself fails, its attached fee comes back here and on_replay refunds it.
        let _replay = ext_outlayer::ext(o.contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(run.fee.0))
            .with_static_gas(GAS_REQUEST_EXECUTION)
            .with_unused_gas_weight(1)
            .request_execution(
                json!({ "WasmUrl": { "url": o.wasm_url, "hash": o.wasm_hash, "build_target": "wasm32-wasip2" } }),
                Some(json!({ "max_instructions": o.max_instructions, "max_memory_mb": 64, "max_execution_seconds": o.max_execution_seconds })),
                Some(input),
                None,
                Some("Json".into()),
                None,
                None,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_REPLAY).on_replay(run_id));
        None
    }

    /// Runner mode: a registered runner hands in the replay job's output for a pending run.
    pub fn submit_replay(&mut self, run_id: u64, result: JobResult) -> Run {
        let before = env::storage_usage();
        let runner = env::predecessor_account_id();
        require!(self.config.mode == ReplayMode::Runner, "replays come from a runner only in Runner mode");
        require!(self.config.runners.contains(&runner), "not a registered runner");
        let run = self.run(run_id);
        require!(run.status == Status::Replaying, "this run isn't waiting for a replay");
        require!(Some(&result.log_hash) == run.log_hash.as_ref(), "that replay is of a different log than the one submitted");
        if !run.fee_spent && run.fee.0 > 0 {
            self.credit(&runner, run.fee.0);
            let mut r = run.clone();
            r.fee_spent = true;
            self.runs.insert(run_id, r);
        }
        self.settle(run_id, Self::replay_of(&result, format!("runner {runner}: the wasip2 job under wasmtime (a trusted runner, not a TEE)")), None, before);
        self.run(run_id)
    }

    /// OutLayer mode: the yield resumed. `result` is the job's stdout JSON, or null if the job failed
    /// or timed out. Anything but a matching result is replayed on-chain right here.
    #[private]
    pub fn on_replay(&mut self, run_id: u64, #[callback_result] result: Result<Option<Value>, PromiseError>) -> Run {
        let before = env::storage_usage();
        let mut run = self.run(run_id);
        if run.status != Status::Replaying {
            return run;
        }
        let parsed = match result {
            Ok(Some(v)) => match serde_json::from_value::<JobResult>(v.clone()) {
                Ok(r) if Some(&r.log_hash) == run.log_hash.as_ref() => Ok(r),
                Ok(_) => Err("OutLayer replayed a different log than the one submitted".to_string()),
                Err(_) => Err(format!("the job answered {}", v.to_string().chars().take(80).collect::<String>())),
            },
            Ok(None) => Err("OutLayer returned no output (the job failed or timed out)".to_string()),
            Err(_) => {
                // request_execution itself failed: its attached fee came back to this contract.
                run.fee_spent = false;
                self.runs.insert(run_id, run.clone());
                Err("the OutLayer call failed (its fee came back)".to_string())
            }
        };
        match parsed {
            Ok(r) => {
                let o = self.config.outlayer.as_ref().map_or("?".to_string(), |o| o.contract.to_string());
                let via = if OUTLAYER_ACCOUNTS.contains(&o.as_str()) {
                    format!("OutLayer ({o}): the wasip2 job on an OutLayer worker")
                } else {
                    format!("{o}: an OutLayer-compatible account the contract owner chose; not verified as a TEE")
                };
                self.settle(run_id, Self::replay_of(&r, via), None, before);
            }
            Err(why) => self.settle_from_pending(run_id, &why, before),
        }
        self.run(run_id)
    }

    fn replay_of(r: &JobResult, via: String) -> Replay {
        Replay { score: r.score, metres: r.metres, gems: r.gems, ticks: r.ticks, survived: r.survived, final_state_hash: r.final_state_hash.clone(), via }
    }

    fn replay_on_chain(run: &Run, log: &[u32], via: &str) -> Replay {
        let gas0 = env::used_gas();
        let g = ghost_sim::replay(&unhex32(&run.seed), log).unwrap_or_else(|e| env::panic_str(e.as_str()));
        let used = env::used_gas().as_gas() - gas0.as_gas();
        env::log_str(&format!("on-chain replay of {} ticks used {}.{:02} Tgas", g.tick, used / 1_000_000_000_000, used % 1_000_000_000_000 / 10_000_000_000));
        Replay {
            score: g.score(),
            metres: g.metres(),
            gems: g.gems,
            ticks: g.tick,
            survived: g.survived(),
            final_state_hash: hex(&env::sha256(&g.state_bytes())),
            via: via.into(),
        }
    }

    /// A pending run whose off-chain replay failed or never came: the contract replays the stored log.
    fn settle_from_pending(&mut self, run_id: u64, why: &str, before: u64) {
        let run = self.run(run_id);
        let log = self.pending_logs.get(&run_id).cloned().unwrap_or_else(|| env::panic_str("this run's log isn't stored"));
        let replay = Self::replay_on_chain(&run, &log, &format!("on-chain fallback ({why})"));
        self.settle(run_id, replay, None, before);
    }

    /// Anyone can close a run that ran out of time: one never submitted forfeits; one whose replay
    /// never came back is replayed on-chain from its stored log.
    pub fn expire_run(&mut self, run_id: u64) -> Run {
        let before = env::storage_usage();
        let run = self.run(run_id);
        let now = env::block_timestamp_ms();
        match run.status {
            Status::Playing => {
                require!(now > run.deadline_ms, "the run still has time");
                self.expire(run_id, before);
            }
            Status::Replaying => {
                require!(now > run.submitted_ms.unwrap_or(0) + self.config.replay_timeout_secs * 1000, "the replay still has time");
                self.settle_from_pending(run_id, "no replay came back in time", before);
            }
            _ => env::panic_str("this run is already settled"),
        }
        self.run(run_id)
    }

    /// A duel whose one race in flight was never submitted and is past its deadline: close that run
    /// as `expire_run` would (a forfeit), freeing the duel. Anything else is left alone.
    fn expire_stale_lock(&mut self, ghost_id: u64) {
        let Some(rid) = self.ghost(ghost_id).lock_run else { return };
        let run = self.run(rid);
        if run.status == Status::Playing && env::block_timestamp_ms() > run.deadline_ms {
            let before = env::storage_usage();
            self.expire(rid, before);
        }
    }

    fn expire(&mut self, run_id: u64, before: u64) {
        let mut run = self.run(run_id);
        run.status = Status::Expired;
        run.note = Some("not submitted in time".into());
        if let Some(gid) = run.ghost {
            self.keep_stake(gid, &mut run, None);
        }
        if run.qualify.is_some() {
            self.unqualify(&mut run);
        }
        self.finish(run, before);
    }

    /// The one place a replayed run is decided. `log` is passed when the caller has it (on-chain
    /// mode); otherwise a qualifier's ghost takes it from the pending store.
    fn settle(&mut self, run_id: u64, replay: Replay, log: Option<Vec<u32>>, before: u64) {
        let mut run = self.run(run_id);
        require!(run.status == Status::Replaying, "this run isn't waiting for a replay");
        let claimed = run.claimed_score.unwrap_or(0);
        run.replay = Some(replay.clone());
        if replay.score != claimed {
            run.status = Status::Refused;
            run.note = Some(format!("refused: claimed {claimed}, but the replay of the submitted inputs scores {}", replay.score));
            if let Some(gid) = run.ghost {
                self.keep_stake(gid, &mut run, None);
            }
            if run.qualify.is_some() {
                self.unqualify(&mut run);
            }
        } else if let Some(gid) = run.ghost {
            let mut g = self.ghost(gid);
            if g.stake.0 == 0 {
                // The public ladder: the record counts, no money moves.
                if replay.score > g.score {
                    run.status = Status::Won;
                    run.note = Some(format!("beat public-ladder ghost #{gid} ({} vs {}); no money moves on the public ladder", replay.score, g.score));
                    g.beaten += 1;
                } else {
                    run.status = Status::Lost;
                    run.note = Some(format!("public-ladder ghost #{gid} held ({} vs {}); no money moves on the public ladder", g.score, replay.score));
                    g.defended += 1;
                    g.best_challenge = g.best_challenge.max(replay.score);
                }
                self.put_ghost(g);
            } else if replay.score > g.score {
                let prize = g.pot.0 + run.stake.0;
                run.status = Status::Won;
                run.note = Some(format!("beat ghost #{gid} ({} vs {}): won its {} NEAR pot", replay.score, g.score, fmt_near(g.pot.0)));
                self.credit(&run.player.clone(), prize);
                g.pot = U128(0);
                g.grown_in_pot = U128(0);
                g.beaten += 1;
                self.put_ghost(g);
            } else {
                run.status = Status::Lost;
                run.note = Some(format!("ghost #{gid} held ({} vs {})", g.score, replay.score));
                self.keep_stake(gid, &mut run, Some(replay.score));
            }
        } else if let Some(q) = run.qualify.clone() {
            if replay.score >= run.min_ghost_score {
                let log = log.or_else(|| self.pending_logs.get(&run_id).cloned()).unwrap_or_else(|| env::panic_str("this run's log isn't stored"));
                let id = self.mint(&mut run, &replay, &q, log);
                run.status = Status::Minted;
                run.minted = Some(id);
                run.note = Some(format!("{} points: minted as ghost #{id} with a {} NEAR pot", replay.score, fmt_near(q.pot.0)));
            } else {
                run.note = Some(format!("{} points, under the {} a ghost needs", replay.score, run.min_ghost_score));
                self.unqualify(&mut run);
            }
        } else {
            run.status = Status::Verified;
            run.note = Some(format!("verified: {} points", replay.score));
        }
        self.finish(run, before);
    }

    /// A qualifier that didn't become a ghost: its pot comes back minus the abandon fee (to the house).
    fn unqualify(&mut self, run: &mut Run) {
        let pot = run.qualify.as_ref().map_or(0, |q| q.pot.0);
        let fee = bps(pot, run.abandon_bps);
        self.credit(&self.config.owner.clone(), fee);
        self.credit(&run.player.clone(), pot - fee);
        if run.status != Status::Refused && run.status != Status::Expired {
            run.status = Status::Unqualified;
        }
        if pot > 0 {
            let n = run.note.take().unwrap_or_default();
            run.note = Some(format!("{n}; the qualifier's pot came back minus {} NEAR", fmt_near(fee)));
        }
    }

    /// A ghost keeps a challenger's stake: the house takes its rake, the pot grows by its share
    /// (and stays locked), the ghost's owner gets the rest. Only a replayed loss (`flown`) counts as
    /// a defence.
    fn keep_stake(&mut self, gid: u64, run: &mut Run, flown: Option<u32>) {
        let mut g = self.ghost(gid);
        if run.stake.0 == 0 {
            // A public-ladder race: nothing was staked, so a forfeit only counts on the record.
            g.forfeits += 1;
            self.put_ghost(g);
            return;
        }
        let rake = bps(run.stake.0, run.rake_bps);
        let grow = bps(run.stake.0, run.pot_bps);
        let earned = run.stake.0 - rake - grow;
        self.credit(&self.config.owner.clone(), rake);
        self.credit(&g.owner.clone(), earned);
        g.pot = U128(g.pot.0 + grow);
        g.grown = U128(g.grown.0 + grow);
        g.grown_in_pot = U128(g.grown_in_pot.0 + grow);
        g.raked = U128(g.raked.0 + rake);
        g.earned = U128(g.earned.0 + earned);
        if grow > 0 {
            g.pot_locked_until_ms = g.pot_locked_until_ms.max(env::block_timestamp_ms() + run.pot_lock_secs * 1000);
        }
        match flown {
            Some(score) => {
                g.defended += 1;
                g.best_challenge = g.best_challenge.max(score);
            }
            None => g.forfeits += 1,
        }
        self.put_ghost(g);
        let n = run.note.take().unwrap_or_default();
        run.note = Some(format!("{n}; the ghost's owner earned {} NEAR and its pot grew {}", fmt_near(earned), fmt_near(grow)));
    }

    fn mint(&mut self, run: &mut Run, replay: &Replay, q: &Qualify, log: Vec<u32>) -> u64 {
        let id = self.ghosts.len() as u64 + 1;
        // The duel's list moves from the run onto the ghost (stored once, paid at start_run).
        let challengers = run.qualify.as_mut().and_then(|q| q.challengers.take()).unwrap_or_default();
        let now = env::block_timestamp_ms();
        let g = Ghost {
            id,
            owner: run.player.clone(),
            pilot: run.player.clone(),
            run: run.id,
            seed: run.seed.clone(),
            score: replay.score,
            metres: replay.metres,
            gems: replay.gems,
            ticks: replay.ticks,
            log_hash: run.log_hash.clone().unwrap_or_default(),
            pot: q.pot.clone(),
            stake: q.stake.clone(),
            defended: 0,
            forfeits: 0,
            beaten: 0,
            best_challenge: 0,
            earned: U128(0),
            grown: U128(0),
            raked: U128(0),
            qualified_pot: q.pot.clone(),
            grown_in_pot: U128(0),
            racing: 0,
            challengers,
            minted_ms: now,
            pot_locked_until_ms: now + run.pot_lock_secs * 1000,
            lock_run: None,
        };
        self.ghosts.push(g);
        self.ghost_logs.insert(id, log);
        nft::emit_mint(&run.player, id);
        id
    }

    /// The end of every run: unlock its ghost, drop its pending log, then square its storage. What
    /// settlement added is paid from the run's reserve (any excess from the player's balance, as far
    /// as it goes); the rest of the reserve, and storage the run freed, go back to the player.
    fn finish(&mut self, mut run: Run, before: u64) {
        if let Some(gid) = run.ghost {
            let mut g = self.ghost(gid);
            g.racing = g.racing.saturating_sub(1);
            if g.lock_run == Some(run.id) {
                g.lock_run = None;
            }
            self.put_ghost(g);
        }
        self.pending.remove(&run.id);
        self.pending_logs.remove(&run.id);
        emit("run_settled", json!({ "run_id": run.id, "status": run.status, "score": run.replay.as_ref().map(|r| r.score), "note": run.note }));
        // A fee no one earned (no replay was needed, or OutLayer's call failed and returned it) goes
        // back to the player.
        let held = run.reserve.0;
        let reserve = run.reserve.0 + if run.fee_spent { 0 } else { run.fee.0 };
        run.reserve = U128(0);
        run.fee_spent = true;
        self.runs.insert(run.id, run.clone());
        self.flush();
        let byte = env::storage_byte_cost().as_yoctonear();
        let now = env::storage_usage();
        let player = run.player.clone();
        if now >= before {
            let cost = (now - before) as u128 * byte;
            let from_reserve = cost.min(reserve);
            let rest = cost - from_reserve;
            let have = self.balance(&player);
            let from_balance = rest.min(have);
            self.balances.insert(player.clone(), have - from_balance + (reserve - from_reserve));
            self.paid_storage += from_reserve + from_balance;
            // The run's key held the reserve; it now counts what settlement took, from the reserve
            // and (never in practice: the reserve is sized for it) from the balance.
            self.release_run_key(&run, held, from_reserve + from_balance);
        } else {
            let freed = ((before - now) as u128 * byte).min(self.paid_storage);
            self.paid_storage -= freed;
            self.credit(&player, reserve + freed);
            self.release_run_key(&run, held, 0);
        }
    }

    // ---------- ghosts ----------

    /// Add to a ghost's pot (yours): a beaten ghost becomes challengeable again. The pot is locked
    /// for `pot_lock_secs` from now.
    #[payable]
    pub fn refill_ghost(&mut self, ghost_id: u64, amount: U128) -> Ghost {
        let who = env::predecessor_account_id();
        let mut g = self.ghost(ghost_id);
        require!(g.owner == who, "not your ghost");
        require!(g.stake.0 > 0 && amount.0 > 0, "a public-ladder ghost holds no money: there's nothing to refill");
        require!(g.pot.0 - g.grown_in_pot.0 + amount.0 <= g.qualified_pot.0, format!("a refill only restores the pot it qualified with ({} NEAR); a bigger pot needs a qualifier that risks it", fmt_near(g.qualified_pot.0)));
        self.spend_from_key(&who, amount.0);
        self.debit(&who, amount.0, "this refill");
        g.pot = U128(g.pot.0 + amount.0);
        require!(g.pot.0 >= g.stake.0, "the pot must be at least the stake");
        g.pot_locked_until_ms = g.pot_locked_until_ms.max(env::block_timestamp_ms() + self.config.pot_lock_secs * 1000);
        self.put_ghost(g.clone());
        g
    }

    /// Name who may race your staked ghost (replacing the list; an empty list closes the duel until
    /// you name someone). Full-access only (1 yoctoNEAR): a session key can't choose who races your
    /// money. The list's storage is paid from your balance. A public-ladder ghost has no list.
    #[payable]
    pub fn set_challengers(&mut self, ghost_id: u64, challengers: Vec<AccountId>) -> Ghost {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let g = self.ghost(ghost_id);
        require!(g.owner == who, "not your ghost");
        require!(g.stake.0 > 0, "a public-ladder ghost holds no money: anyone may race it");
        Self::check_challengers(&challengers, 0);
        require!(!challengers.contains(&who), "you can't race your own ghost: name the players who will");
        // Not while a race is in flight (docs/decisions/0023): the challenger started against this
        // list, and a second account named now could otherwise be raced in ahead of them.
        self.expire_stale_lock(ghost_id);
        let mut g = self.ghost(ghost_id);
        require!(g.racing == 0, "a race is in flight: the list can change when it lands (90 s at most)");
        let before = env::storage_usage();
        g.challengers = challengers;
        self.put_ghost(g.clone());
        let cost = self.storage_since(before);
        if cost > 0 {
            self.charge_storage(&who, cost, "the list's storage");
        }
        emit("challengers_set", json!({ "ghost_id": ghost_id, "challengers": g.challengers }));
        g
    }

    /// Take a ghost's pot back into your balance: not while someone is racing it, and not until its
    /// pot lock has passed (so a weak ghost can't be minted and quietly withdrawn).
    pub fn retire_ghost(&mut self, ghost_id: u64) -> Ghost {
        let who = env::predecessor_account_id();
        let g = self.ghost(ghost_id);
        require!(g.owner == who, "not your ghost");
        // A race past its deadline is closed first: the stake it forfeits grows the pot, and a pot
        // that grew is locked again like any other.
        self.expire_stale_lock(ghost_id);
        let mut g = self.ghost(ghost_id);
        require!(env::block_timestamp_ms() >= g.pot_locked_until_ms, format!("this pot is locked until {} ms (pot_lock_secs after it was minted, refilled or grew)", g.pot_locked_until_ms));
        require!(g.racing == 0, "challenges are in flight: wait for them, or expire_run the ones past their deadline");
        // The owner takes back what they put in; what kept stakes added goes to the house, so
        // stakes paid to your own ghost can't come home through it.
        self.credit(&who, g.pot.0 - g.grown_in_pot.0);
        self.credit(&self.config.owner.clone(), g.grown_in_pot.0);
        g.pot = U128(0);
        g.grown_in_pot = U128(0);
        self.put_ghost(g.clone());
        g
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn get_key_cap(&self, account_id: AccountId, public_key: PublicKey) -> Option<KeyCap> {
        self.key_caps.get(&(account_id, public_key)).cloned()
    }

    /// Storage the players have paid for, against what the contract stores: `paid_storage` is never
    /// below the storage used since `new`, minus the contract's own fixed state.
    pub fn get_storage(&self) -> Value {
        json!({ "paid": U128(self.paid_storage), "usage_bytes": env::storage_usage(), "byte_cost": U128(env::storage_byte_cost().as_yoctonear()) })
    }

    pub fn get_run(&self, run_id: u64) -> Option<Run> {
        self.runs.get(&run_id).cloned()
    }

    /// The newest runs first.
    pub fn get_runs(&self, from: Option<u64>, limit: Option<u32>) -> Vec<Run> {
        let top = from.map_or(self.next_run.saturating_sub(1), |f| f.min(self.next_run.saturating_sub(1)));
        (1..=top).rev().take(limit.unwrap_or(20).min(100) as usize).filter_map(|i| self.runs.get(&i).cloned()).collect()
    }

    pub fn get_ghost(&self, ghost_id: u64) -> Option<Ghost> {
        self.ghosts.get(ghost_index(ghost_id)?).cloned()
    }

    pub fn get_ghosts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Ghost> {
        self.ghosts.iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).cloned().collect()
    }

    /// The seed and log a ghost flew, so a client can replay it (and check `log_hash`).
    pub fn get_ghost_log(&self, ghost_id: u64) -> Option<Value> {
        let g = self.get_ghost(ghost_id)?;
        let log = self.ghost_logs.get(&g.id)?;
        Some(json!({ "seed": g.seed, "log": log, "log_hash": g.log_hash }))
    }

    /// Runs waiting for an off-chain replay, with what the job needs.
    pub fn pending_replays(&self, limit: Option<u32>) -> Vec<Value> {
        self.pending
            .iter()
            .take(limit.unwrap_or(10).min(50) as usize)
            .filter_map(|id| {
                let r = self.runs.get(id)?;
                Some(json!({ "run_id": *id, "seed": r.seed, "log": self.pending_logs.get(id)?, "log_hash": r.log_hash, "claimed_score": r.claimed_score }))
            })
            .collect()
    }

    // ---------- internals ----------

    fn run(&self, id: u64) -> Run {
        self.runs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such run"))
    }

    pub(crate) fn ghost(&self, id: u64) -> Ghost {
        ghost_index(id).and_then(|i| self.ghosts.get(i)).cloned().unwrap_or_else(|| env::panic_str("no such ghost"))
    }

    pub(crate) fn put_ghost(&mut self, g: Ghost) {
        let i = ghost_index(g.id).unwrap_or_else(|| env::panic_str("no such ghost"));
        self.ghosts.replace(i, g);
    }
}
