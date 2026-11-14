//! The replay job. A TEE worker on OutLayer (production) or a registered runner under wasmtime
//! (tonight) runs exactly this wasm32-wasip2 binary:
//!
//!   stdin:  {"seed": "<64 hex>", "log": [tick, tick, ...]}     (the contract's `input_data`)
//!   stdout: {"score": 812, "metres": 587, "gems": 9, "ticks": 2210, "survived": false,
//!            "final_state_hash": "<sha256 hex of the state bytes>", "log_hash": "<sha256 hex of the log bytes>"}
//!
//! or `{"error": "..."}` for input it cannot replay. The contract checks `log_hash` against the hash
//! it stored when the run was submitted, then compares `score` with the claimed one. Under 300 bytes,
//! well inside OutLayer's ~900-byte callback limit.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;

fn run(input: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| format!("input is not JSON: {e}"))?;
    let seed_hex = v["seed"].as_str().ok_or("no seed")?;
    let seed_vec = hex::decode(seed_hex).map_err(|_| "seed is not hex")?;
    let seed: [u8; 32] = seed_vec.try_into().map_err(|_| "seed is not 32 bytes")?;
    let log: Vec<u32> = v["log"]
        .as_array()
        .ok_or("no log")?
        .iter()
        .map(|t| t.as_u64().filter(|&t| t <= u32::MAX as u64).map(|t| t as u32).ok_or("a log entry is not a u32"))
        .collect::<Result<_, _>>()?;
    let mut bytes = vec![0u8; ghost_sim::log_bytes_len(&log)];
    ghost_sim::write_log_bytes(&log, &mut bytes);
    let g = ghost_sim::replay(&seed, &log).map_err(|e| e.as_str().to_string())?;
    Ok(json!({
        "score": g.score(),
        "metres": g.metres(),
        "gems": g.gems,
        "ticks": g.tick,
        "survived": g.survived(),
        "final_state_hash": hex::encode(Sha256::digest(g.state_bytes())),
        "log_hash": hex::encode(Sha256::digest(&bytes)),
    }))
}

fn main() {
    let mut input = String::new();
    let out = match std::io::stdin().read_to_string(&mut input) {
        Ok(_) => run(&input).unwrap_or_else(|e| json!({ "error": e })),
        Err(e) => json!({ "error": format!("stdin: {e}") }),
    };
    println!("{out}");
}
