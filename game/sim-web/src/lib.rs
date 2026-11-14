//! The browser build of `ghost-sim` (wasm32-unknown-unknown). Two game slots: 0 is the player, 1 is
//! the ghost being played back (or any replay). Data goes in and out through one scratch buffer
//! (`gd_buf`): the 32-byte seed, a log as u32 little-endian ticks, the state bytes. No wasm-bindgen,
//! no allocator calls from JS: `web/src/sim.ts` and `demo/killtest.ts` load this same file.
#![allow(static_mut_refs)]
use ghost_sim::{replay, Game, COLS, MAX_TOGGLES, NO_GEM, STATE_LEN};

const SLOTS: usize = 2;
static mut GAMES: [Option<Game>; SLOTS] = [None, None];
static mut LOGS: [[u32; MAX_TOGGLES]; SLOTS] = [[0; MAX_TOGGLES]; SLOTS];
static mut LOG_LEN: [usize; SLOTS] = [0; SLOTS];
static mut BUF: [u8; 16384] = [0; 16384];

fn seed() -> [u8; 32] {
    let mut s = [0u8; 32];
    unsafe { s.copy_from_slice(&BUF[..32]) };
    s
}

fn game(slot: u32) -> &'static mut Game {
    unsafe { GAMES[slot as usize % SLOTS].as_mut().expect("gd_new first") }
}

/// The scratch buffer (16 KiB) for seeds, logs and state bytes.
#[no_mangle]
pub extern "C" fn gd_buf() -> *mut u8 {
    unsafe { BUF.as_mut_ptr() }
}

/// Start a run in `slot` on the seed in the buffer's first 32 bytes.
#[no_mangle]
pub extern "C" fn gd_new(slot: u32) {
    let s = seed();
    unsafe {
        GAMES[slot as usize % SLOTS] = Some(Game::new(&s));
        LOG_LEN[slot as usize % SLOTS] = 0;
    }
}

/// One tick with the button `held` (0 or 1). Records the change in the slot's log. Returns 1 when
/// the run is over.
#[no_mangle]
pub extern "C" fn gd_step(slot: u32, held: u32) -> u32 {
    let i = slot as usize % SLOTS;
    let g = game(slot);
    let mut held = held != 0;
    if held != g.held && !g.done {
        unsafe {
            if LOG_LEN[i] < MAX_TOGGLES {
                LOGS[i][LOG_LEN[i]] = g.tick;
                LOG_LEN[i] += 1;
            } else {
                held = g.held; // the log is full: the button no longer changes
            }
        }
    }
    g.step(held);
    g.done as u32
}

#[no_mangle]
pub extern "C" fn gd_tick(slot: u32) -> u32 {
    game(slot).tick
}
/// Ship height, Q8 pixels.
#[no_mangle]
pub extern "C" fn gd_y(slot: u32) -> i32 {
    game(slot).y
}
#[no_mangle]
pub extern "C" fn gd_vy(slot: u32) -> i32 {
    game(slot).vy
}
/// Distance flown, Q8 pixels.
#[no_mangle]
pub extern "C" fn gd_dist(slot: u32) -> i32 {
    game(slot).dist
}
#[no_mangle]
pub extern "C" fn gd_gems(slot: u32) -> u32 {
    game(slot).gems
}
#[no_mangle]
pub extern "C" fn gd_alive(slot: u32) -> u32 {
    game(slot).alive as u32
}
#[no_mangle]
pub extern "C" fn gd_done(slot: u32) -> u32 {
    game(slot).done as u32
}
#[no_mangle]
pub extern "C" fn gd_score(slot: u32) -> u32 {
    game(slot).score()
}
#[no_mangle]
pub extern "C" fn gd_metres(slot: u32) -> u32 {
    game(slot).metres()
}

/// Cave column `k`, packed as `top | bot << 8 | (gem + 1) << 16` (gem + 1 = 0: none), or -1.
#[no_mangle]
pub extern "C" fn gd_col(slot: u32, k: u32) -> i32 {
    match game(slot).column(k) {
        Some(c) => {
            let gem = if c.gem == NO_GEM { 0 } else { c.gem as i32 + 1 };
            (c.top as i32 & 0xff) | (c.bot as i32 & 0xff) << 8 | gem << 16
        }
        None => -1,
    }
}

/// Columns kept in memory.
#[no_mangle]
pub extern "C" fn gd_cols() -> u32 {
    COLS as u32
}

/// Write the slot's log (u32 LE ticks) to the buffer; returns how many ticks.
#[no_mangle]
pub extern "C" fn gd_log(slot: u32) -> u32 {
    let i = slot as usize % SLOTS;
    unsafe {
        let n = LOG_LEN[i];
        for k in 0..n {
            BUF[k * 4..k * 4 + 4].copy_from_slice(&LOGS[i][k].to_le_bytes());
        }
        n as u32
    }
}

/// Write the slot's state bytes to the buffer; returns their length.
#[no_mangle]
pub extern "C" fn gd_state(slot: u32) -> u32 {
    let b = game(slot).state_bytes();
    unsafe { BUF[..STATE_LEN].copy_from_slice(&b) };
    STATE_LEN as u32
}

/// Replay into `slot`: the seed in buffer bytes 0..32, then `n` ticks (u32 LE) from byte 32.
/// Returns the score, or -1 for a log `ghost_sim::check_log` refuses.
#[no_mangle]
pub extern "C" fn gd_replay(slot: u32, n: u32) -> i32 {
    let s = seed();
    let n = (n as usize).min(MAX_TOGGLES + 1);
    let mut log = [0u32; MAX_TOGGLES + 1];
    unsafe {
        for k in 0..n {
            let o = 32 + k * 4;
            log[k] = u32::from_le_bytes([BUF[o], BUF[o + 1], BUF[o + 2], BUF[o + 3]]);
        }
    }
    match replay(&s, &log[..n]) {
        Ok(g) => {
            let score = g.score() as i32;
            unsafe {
                GAMES[slot as usize % SLOTS] = Some(g);
            }
            score
        }
        Err(_) => -1,
    }
}
