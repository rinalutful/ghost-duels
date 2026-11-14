//! Ghosts as NEP-171 NFTs: core (transfer, transfer_call, token), metadata (NEP-177), enumeration
//! (NEP-181) and events (NEP-297). Hand-rolled rather than near-contract-standards to keep the wasm
//! small (docs/decisions/0005). No approvals (NEP-178): `approval_id` must be omitted.
//!
//! A token's metadata is computed when it is read, from the ghost's live record, so a wallet or
//! marketplace always shows how many challengers it has beaten and what it has earned.
use crate::{fmt_near, GhostDuels, GhostDuelsExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, PromiseError, PromiseOrValue};
use std::collections::HashMap;

const GAS_ON_TRANSFER: Gas = Gas::from_tgas(25);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub approved_account_ids: Option<HashMap<AccountId, u64>>,
}

#[ext_contract(ext_nft_receiver)]
#[allow(dead_code)]
trait NftReceiver {
    fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool>;
}

fn nep171(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep171", "version": "1.0.0", "event": event, "data": [data] })));
}

pub(crate) fn emit_mint(owner: &AccountId, id: u64) {
    nep171("nft_mint", json!({ "owner_id": owner, "token_ids": [id.to_string()] }));
}

fn parse_id(token_id: &str) -> u64 {
    token_id.parse::<u64>().unwrap_or_else(|_| env::panic_str("token ids are ghost numbers: \"1\", \"2\", ..."))
}

fn data_uri(svg: &str) -> String {
    let mut out = String::from("data:image/svg+xml;charset=utf-8,");
    for c in svg.chars() {
        match c {
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '"' => out.push('\''),
            '\n' => {}
            _ => out.push(c),
        }
    }
    out
}

const ICON: &str = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='#0b1020'/><path d='M8 26V14a8 8 0 0 1 16 0v12l-3-2-2.5 2-2.5-2-2.5 2-2.5-2z' fill='#9ef0ff'/><circle cx='13' cy='14' r='2' fill='#0b1020'/><circle cx='19' cy='14' r='2' fill='#0b1020'/></svg>";

impl GhostDuels {
    fn token(&self, id: u64) -> Option<Token> {
        let g = self.get_ghost(id)?;
        let state = if g.stake.0 == 0 {
            "on the public ladder: anyone may race it, and no money moves".to_string()
        } else {
            let open = if g.racing > 0 { "challengers racing it now" } else if g.pot.0 == 0 { "beaten, waiting for a refill" } else { "open to its challengers" };
            format!("a private duel: only the {} challengers its owner named may race it; {open}", g.challengers.len())
        };
        let title = format!("Ghost #{} · {} pts", g.id, g.score);
        let description = format!(
            "A recorded run in Ghost Duels' cave: {} m, {} gems. Defended {} (best losing challenge {}) · forfeits {} · beaten {}. Earned its owners {} NEAR; kept stakes grew its pot {} NEAR and paid the house {} NEAR. A defence can be faked from a second account, and a challenger can be its owner's: the record proves runs were flown and paid for, not who flew them. Pot {} NEAR, stake {} NEAR; {}.",
            g.metres, g.gems, g.defended, g.best_challenge, g.forfeits, g.beaten, fmt_near(g.earned.0), fmt_near(g.grown.0), fmt_near(g.raked.0), fmt_near(g.pot.0), fmt_near(g.stake.0), state
        );
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'><rect width='300' height='300' fill='#0b1020'/>\
<path d='M0 70 L40 60 L80 78 L120 52 L160 66 L200 44 L240 62 L300 50 L300 0 L0 0Z M0 240 L50 226 L90 248 L140 222 L190 240 L240 218 L300 236 L300 300 L0 300Z' fill='#2a3352'/>\
<path d='M120 190V130a30 30 0 0 1 60 0v60l-10-7-10 7-10-7-10 7-10-7z' fill='#9ef0ff' opacity='0.85'/><circle cx='140' cy='130' r='6' fill='#0b1020'/><circle cx='160' cy='130' r='6' fill='#0b1020'/>\
<text x='150' y='40' fill='#e8ecff' font-family='monospace' font-size='20' text-anchor='middle'>GHOST #{}</text>\
<text x='150' y='215' fill='#ffd36e' font-family='monospace' font-size='22' text-anchor='middle'>{} pts</text>\
<text x='150' y='262' fill='#e8ecff' font-family='monospace' font-size='13' text-anchor='middle'>held {} · beaten {} · earned {}</text>\
<text x='150' y='282' fill='#8a93b8' font-family='monospace' font-size='12' text-anchor='middle'>pot {} · stake {} NEAR</text></svg>",
            g.id, g.score, g.defended, g.beaten, fmt_near(g.earned.0), fmt_near(g.pot.0), fmt_near(g.stake.0)
        );
        let extra = json!({ "score": g.score, "metres": g.metres, "gems": g.gems, "ticks": g.ticks, "pilot": g.pilot, "run": g.run,
            "defended": g.defended, "forfeits": g.forfeits, "racing": g.racing, "qualified_pot": g.qualified_pot, "beaten": g.beaten, "best_challenge": g.best_challenge, "earned": g.earned, "grown": g.grown, "raked": g.raked, "pot": g.pot, "stake": g.stake, "seed": g.seed, "log_hash": g.log_hash, "challengers": g.challengers });
        Some(Token {
            token_id: g.id.to_string(),
            owner_id: g.owner,
            metadata: Some(TokenMetadata {
                title: Some(title),
                description: Some(description),
                media: Some(data_uri(&svg)), // only numbers and fixed words: nothing to escape
                media_hash: None,
                copies: Some(1),
                issued_at: Some(g.minted_ms.to_string()),
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: Some(extra.to_string()),
                reference: None,
                reference_hash: None,
            }),
            approved_account_ids: Some(HashMap::new()),
        })
    }

    fn transfer(&mut self, sender: &AccountId, receiver: &AccountId, token_id: &str, approval_id: Option<u64>, memo: Option<String>) -> AccountId {
        require!(approval_id.is_none(), "approvals are not supported: the owner transfers");
        let id = parse_id(token_id);
        let mut g = self.ghost(id);
        require!(&g.owner == sender, "only the ghost's owner can transfer it");
        require!(&g.owner != receiver, "the receiver already owns it");
        let prev = g.owner.clone();
        g.owner = receiver.clone();
        // A longer owner id grows the record: the sender pays for it from their in-game balance.
        let before = env::storage_usage();
        self.put_ghost(g);
        let cost = self.storage_cost_since(before);
        if cost > 0 {
            self.charge_storage(sender, cost, "this transfer's storage (a longer account id)");
        }
        let mut data = json!({ "old_owner_id": prev, "new_owner_id": receiver, "token_ids": [token_id] });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        nep171("nft_transfer", data);
        prev
    }
}

#[near]
impl GhostDuels {
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, &token_id, approval_id, memo);
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(env::prepaid_gas().as_tgas() >= 50, "attach at least 50 Tgas");
        let sender = env::predecessor_account_id();
        let prev = self.transfer(&sender, &receiver_id, &token_id, approval_id, memo);
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER)
            .nft_on_transfer(sender, prev.clone(), token_id.clone(), msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_RESOLVE).nft_resolve_transfer(prev, receiver_id, token_id, None))
            .into()
    }

    /// NEP-171: undo the transfer if the receiver asked for it back (returned true) or failed.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
        #[callback_result] give_back: Result<bool, PromiseError>,
    ) -> bool {
        let _ = approved_account_ids;
        if !give_back.unwrap_or(true) {
            return true;
        }
        let id = parse_id(&token_id);
        let mut g = self.ghost(id);
        if g.owner != receiver_id {
            return true; // the receiver already passed it on
        }
        g.owner = previous_owner_id.clone();
        self.put_ghost(g);
        nep171("nft_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": previous_owner_id, "token_ids": [token_id] }));
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.token(token_id.parse::<u64>().ok()?)
    }

    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Ghost Duels".into(),
            symbol: "GHOST".into(),
            icon: Some(data_uri(ICON)),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.ghosts.len() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let start = from_index.map_or(0, |f| f.0 as u64);
        (start + 1..=self.ghosts.len() as u64).take(limit.unwrap_or(50).min(100) as usize).filter_map(|i| self.token(i)).collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.ghosts.iter().filter(|g| g.owner == account_id).count() as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.ghosts
            .iter()
            .filter(|g| g.owner == account_id)
            .skip(from_index.map_or(0, |f| f.0 as usize))
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|g| self.token(g.id))
            .collect()
    }
}
