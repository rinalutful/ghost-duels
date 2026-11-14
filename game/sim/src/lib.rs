//! Cave Ghost: a one-button cave flyer, as a deterministic simulation.
//!
//! Hold the button to thrust up, let go to fall. The cave scrolls faster and narrows as you go; gems
//! are worth 25. A run ends when you touch the rock, or after 60 s (3600 ticks), whichever is first.
//!
//! **Everything here is integer arithmetic.** Positions are fixed-point (Q8: 256 units per pixel),
//! the random numbers come from an xorshift64* seeded with the run's 32-byte on-chain seed, and the
//! only input is the tick numbers at which the button changed state. So the same seed and the same
//! input log give the same final state, byte for byte, in every build of this crate:
//!
//! - the browser (`../sim-web`, wasm32-unknown-unknown);
//! - the replay job a TEE or a registered runner executes (`../replay-job`, wasm32-wasip2);
//! - the contract itself, which can replay a run on-chain (`../../contracts/ghost-duels`).
//!
//! `npm run killtest` checks the first two against each other; the sandbox suite checks the third.
//! No `std`, no allocator, no dependencies, and no floats anywhere: nothing a platform could round
//! differently.
#![no_std]

/// Simulation ticks per second.
pub const TICK_HZ: u32 = 60;
/// A run lasts at most 60 seconds.
pub const MAX_TICKS: u32 = 3600;
/// At most this many button changes per run (a log longer than this is refused).
pub const MAX_TOGGLES: usize = 2048;
/// The visible playfield, in pixels.
pub const VIEW_W: i32 = 320;
pub const VIEW_H: i32 = 180;
/// The cave is made of vertical columns this many pixels wide.
pub const COL_W: i32 = 8;
/// Columns kept in memory (a ring): more than a screen's worth.
pub const COLS: usize = 64;
/// The ship's horizontal position on screen, in pixels, and its radius.
pub const SHIP_X: i32 = 72;
pub const SHIP_R: i32 = 4;
/// Fixed-point scale: 256 units per pixel.
pub const FP: i32 = 256;
/// A column with no gem.
pub const NO_GEM: i16 = -1;
/// Points per gem, and for surviving the full 60 s.
pub const GEM_POINTS: u32 = 25;
pub const SURVIVAL_BONUS: u32 = 250;
/// Pixels per metre on the score.
pub const PX_PER_M: i32 = 8;

const RUNWAY: u32 = 40;
const THRUST: i32 = 51; // Q8 px/tick², upward while held
const GRAVITY: i32 = 44; // Q8 px/tick², downward otherwise
const VMAX: i32 = 820; // Q8 px/tick
const SPEED0: i32 = 512; // 2 px/tick at the start
const SPEED_GAIN: i32 = 384; // +1.5 px/tick by the end
const START_GAP: i32 = 132;
const MIN_GAP: i32 = 50;
const GEM_REACH: i32 = 7 * FP;

/// One column of cave: the rock above `top` and below `bot`, and maybe a gem at height `gem`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Column {
    pub top: i16,
    pub bot: i16,
    pub gem: i16,
}

/// Why a log cannot be replayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogError {
    TooLong,
    NotIncreasing,
    PastEnd,
}

impl LogError {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogError::TooLong => "the input log has more than 2048 button changes",
            LogError::NotIncreasing => "the input log's ticks must strictly increase",
            LogError::PastEnd => "the input log has a tick at or past 3600",
        }
    }
}

/// The whole game state. Plain integers, so it serializes to fixed bytes (`state_bytes`).
#[derive(Clone, Debug)]
pub struct Game {
    pub tick: u32,
    /// Ship height, Q8 pixels from the top.
    pub y: i32,
    /// Vertical speed, Q8 pixels per tick (negative is up).
    pub vy: i32,
    /// Distance flown, Q8 pixels. The camera's left edge is `dist / FP`.
    pub dist: i32,
    pub gems: u32,
    pub held: bool,
    pub alive: bool,
    pub done: bool,
    rng: u64,
    center: i32,
    slope: i32,
    spike_left: u8,
    spike_top: bool,
    spike_h: i32,
    gem_cooldown: u32,
    next_col: u32,
    cols: [Column; COLS],
}

/// Bytes in `state_bytes`.
pub const STATE_LEN: usize = 4 * 5 + 1 + 8 + 4 * 2 + 1 + 1 + 4 * 3 + COLS * 6;

fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Game {
    /// A new run on the cave that `seed` (the run's on-chain seed) generates.
    pub fn new(seed: &[u8; 32]) -> Game {
        let mut s: u64 = 0x6A09_E667_F3BC_C908;
        for w in seed.chunks_exact(8) {
            let mut b = [0u8; 8];
            b.copy_from_slice(w);
            s = splitmix64(s ^ u64::from_le_bytes(b));
        }
        let mut g = Game {
            tick: 0,
            y: 90 * FP,
            vy: 0,
            dist: 0,
            gems: 0,
            held: false,
            alive: true,
            done: false,
            rng: if s == 0 { 1 } else { s },
            center: 90,
            slope: 0,
            spike_left: 0,
            spike_top: false,
            spike_h: 0,
            gem_cooldown: 0,
            next_col: 0,
            cols: [Column { top: 0, bot: VIEW_H as i16, gem: NO_GEM }; COLS],
        };
        g.ensure_columns();
        g
    }

    fn next_u32(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u32
    }

    fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }

    /// A uniform integer in `lo..=hi`.
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + self.below((hi - lo + 1) as u32) as i32
    }

    fn gen_column(&mut self, k: u32) -> Column {
        if k < RUNWAY {
            return Column { top: 20, bot: 160, gem: NO_GEM };
        }
        let d = (k - RUNWAY) as i32;
        let gap = (START_GAP - d * 80 / 1200).max(MIN_GAP);
        let max_slope = 1 + d / 300;
        self.slope = (self.slope + self.range(-1, 1)).clamp(-max_slope, max_slope);
        self.center += self.slope;
        let lo = gap / 2 + 6;
        let hi = VIEW_H - gap / 2 - 6;
        if self.center < lo {
            self.center = lo;
            self.slope = self.slope.abs();
        }
        if self.center > hi {
            self.center = hi;
            self.slope = -self.slope.abs();
        }
        let mut top = self.center - gap / 2;
        let mut bot = self.center + gap / 2;
        if self.spike_left == 0 && d > 120 && self.below(100) < (3 + d as u32 / 200).min(8) {
            self.spike_left = 3;
            self.spike_top = self.below(2) == 0;
            self.spike_h = gap * self.range(25, 40) / 100;
        }
        if self.spike_left > 0 {
            self.spike_left -= 1;
            if self.spike_top {
                top += self.spike_h;
            } else {
                bot -= self.spike_h;
            }
        }
        let mut gem = NO_GEM;
        if self.gem_cooldown > 0 {
            self.gem_cooldown -= 1;
        } else if self.below(14) == 0 {
            let q = gap / 4;
            let gy = (self.center + self.range(-q, q)).clamp(top + 8, bot - 8);
            if top + 8 <= bot - 8 {
                gem = gy as i16;
                self.gem_cooldown = 10;
            }
        }
        Column { top: top as i16, bot: bot as i16, gem }
    }

    fn ensure_columns(&mut self) {
        let last = ((self.dist / FP + VIEW_W) / COL_W + 1) as u32;
        while self.next_col <= last {
            let k = self.next_col;
            let c = self.gen_column(k);
            self.cols[k as usize % COLS] = c;
            self.next_col += 1;
        }
    }

    /// The cave column with world index `k` (`k * COL_W` pixels from the start), if it is in memory.
    pub fn column(&self, k: u32) -> Option<Column> {
        if k < self.next_col && k + COLS as u32 >= self.next_col {
            Some(self.cols[k as usize % COLS])
        } else {
            None
        }
    }

    /// The camera's left edge, in world pixels.
    pub fn cam(&self) -> i32 {
        self.dist / FP
    }

    /// Advance one tick with the button `held` (or not).
    pub fn step(&mut self, held: bool) {
        if self.done {
            return;
        }
        self.held = held;
        let a = if held { -THRUST } else { GRAVITY };
        self.vy = (self.vy + a).clamp(-VMAX, VMAX);
        self.y += self.vy;
        self.dist += SPEED0 + (self.tick as i32 * SPEED_GAIN) / MAX_TICKS as i32;
        self.ensure_columns();
        self.collide();
        self.tick += 1;
        if self.alive && self.tick >= MAX_TICKS {
            self.done = true;
        }
    }

    fn collide(&mut self) {
        let sx = self.dist / FP + SHIP_X;
        let (k0, k1) = (((sx - SHIP_R) / COL_W) as u32, ((sx + SHIP_R) / COL_W) as u32);
        for k in k0..=k1 {
            let i = k as usize % COLS;
            let c = self.cols[i];
            if self.y - SHIP_R * FP < c.top as i32 * FP || self.y + SHIP_R * FP > c.bot as i32 * FP {
                self.alive = false;
                self.done = true;
                return;
            }
            if c.gem != NO_GEM && (self.y - c.gem as i32 * FP).abs() <= GEM_REACH {
                self.gems += 1;
                self.cols[i].gem = NO_GEM;
            }
        }
    }

    /// True if the ship flew the full 60 s.
    pub fn survived(&self) -> bool {
        self.done && self.alive
    }

    /// Metres flown (8 px each).
    pub fn metres(&self) -> u32 {
        (self.dist / FP / PX_PER_M) as u32
    }

    /// The score: metres, plus 25 per gem, plus 250 for surviving the full minute.
    pub fn score(&self) -> u32 {
        self.metres() + self.gems * GEM_POINTS + if self.survived() { SURVIVAL_BONUS } else { 0 }
    }

    /// The whole state as fixed little-endian bytes, for hashing (`final_state_hash` = its SHA-256).
    pub fn state_bytes(&self) -> [u8; STATE_LEN] {
        let mut out = [0u8; STATE_LEN];
        let mut at = 0;
        let mut put = |b: &[u8]| {
            out[at..at + b.len()].copy_from_slice(b);
            at += b.len();
        };
        put(&self.tick.to_le_bytes());
        put(&self.y.to_le_bytes());
        put(&self.vy.to_le_bytes());
        put(&self.dist.to_le_bytes());
        put(&self.gems.to_le_bytes());
        put(&[self.held as u8 | (self.alive as u8) << 1 | (self.done as u8) << 2]);
        put(&self.rng.to_le_bytes());
        put(&self.center.to_le_bytes());
        put(&self.slope.to_le_bytes());
        put(&[self.spike_left]);
        put(&[self.spike_top as u8]);
        put(&self.spike_h.to_le_bytes());
        put(&self.gem_cooldown.to_le_bytes());
        put(&self.next_col.to_le_bytes());
        for c in &self.cols {
            put(&c.top.to_le_bytes());
            put(&c.bot.to_le_bytes());
            put(&c.gem.to_le_bytes());
        }
        out
    }
}

/// Check a log of button changes: at most 2048, strictly increasing ticks, each below 3600.
pub fn check_log(toggles: &[u32]) -> Result<(), LogError> {
    if toggles.len() > MAX_TOGGLES {
        return Err(LogError::TooLong);
    }
    let mut prev: Option<u32> = None;
    for &t in toggles {
        if t >= MAX_TICKS {
            return Err(LogError::PastEnd);
        }
        if prev.is_some_and(|p| t <= p) {
            return Err(LogError::NotIncreasing);
        }
        prev = Some(t);
    }
    Ok(())
}

/// The canonical bytes of a log: each tick as a u32, little-endian. `log_hash` = their SHA-256.
pub fn log_bytes_len(toggles: &[u32]) -> usize {
    toggles.len() * 4
}

pub fn write_log_bytes(toggles: &[u32], out: &mut [u8]) {
    for (i, t) in toggles.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&t.to_le_bytes());
    }
}

/// Replay a run: the button starts released and flips at each tick in `toggles`. Ticks after the
/// run ended (a crash) are ignored. Returns the final state.
pub fn replay(seed: &[u8; 32], toggles: &[u32]) -> Result<Game, LogError> {
    check_log(toggles)?;
    let mut g = Game::new(seed);
    let mut held = false;
    let mut next = 0;
    while !g.done {
        if next < toggles.len() && toggles[next] == g.tick {
            held = !held;
            next += 1;
        }
        g.step(held);
    }
    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(n: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = n.wrapping_mul(31).wrapping_add(i as u8);
        }
        s
    }

    /// A simple autopilot: hold when below the cave's middle ahead. Returns its toggle log.
    fn autopilot(seed: &[u8; 32], look: i32) -> [u32; MAX_TOGGLES] {
        let mut g = Game::new(seed);
        let mut log = [0u32; MAX_TOGGLES];
        let mut n = 0;
        while !g.done {
            let k = ((g.cam() + SHIP_X + look) / COL_W) as u32;
            let c = g.column(k).unwrap();
            let mid = (c.top as i32 + c.bot as i32) / 2 * FP;
            let want = g.y + g.vy * 6 > mid;
            if want != g.held && n < MAX_TOGGLES {
                log[n] = g.tick;
                n += 1;
                g.step(want);
            } else {
                let h = g.held;
                g.step(h);
            }
        }
        log
    }

    #[test]
    fn no_input_falls_and_crashes() {
        let g = replay(&seed(1), &[]).unwrap();
        assert!(!g.alive && g.done);
        assert!(g.tick < 120, "a released button falls into the floor fast: {}", g.tick);
    }

    #[test]
    fn same_seed_same_log_same_bytes() {
        let s = seed(7);
        let a = replay(&s, &[10, 30, 50, 75, 90, 120]).unwrap();
        let b = replay(&s, &[10, 30, 50, 75, 90, 120]).unwrap();
        assert_eq!(a.state_bytes(), b.state_bytes());
        assert_eq!(a.score(), b.score());
    }

    #[test]
    fn seeds_make_different_caves() {
        let a = Game::new(&seed(1));
        let mut ga = a.clone();
        let mut gb = Game::new(&seed(2));
        for _ in 0..1500 {
            ga.step(false);
            gb.step(false);
        }
        // Compare cave columns past the runway directly.
        let mut ca = Game::new(&seed(1));
        let mut cb = Game::new(&seed(2));
        for _ in 0..400 {
            ca.dist += 8 * FP;
            ca.ensure_columns();
            cb.dist += 8 * FP;
            cb.ensure_columns();
        }
        assert_ne!(ca.state_bytes(), cb.state_bytes());
    }

    #[test]
    fn live_play_matches_replay() {
        let s = seed(3);
        let log = autopilot(&s, 24);
        let n = log.iter().skip(1).position(|&t| t == 0).map_or(MAX_TOGGLES, |p| p + 1);
        let toggles = &log[..n];
        // Re-run live, feeding held states tick by tick, and compare with replay of the log.
        let mut live = Game::new(&s);
        let mut held = false;
        let mut i = 0;
        while !live.done {
            if i < toggles.len() && toggles[i] == live.tick {
                held = !held;
                i += 1;
            }
            live.step(held);
        }
        let rep = replay(&s, toggles).unwrap();
        assert_eq!(live.state_bytes(), rep.state_bytes());
        assert!(rep.score() > 100, "the autopilot flies a while: {}", rep.score());
    }

    #[test]
    fn bad_logs_refused() {
        assert_eq!(check_log(&[5, 5]), Err(LogError::NotIncreasing));
        assert_eq!(check_log(&[9, 3]), Err(LogError::NotIncreasing));
        assert_eq!(check_log(&[3600]), Err(LogError::PastEnd));
        let long = [0u32; MAX_TOGGLES + 1];
        assert_eq!(check_log(&long), Err(LogError::TooLong));
    }

    #[test]
    fn runs_end_by_the_minute() {
        // Hold forever: hits the ceiling.
        let g = replay(&seed(4), &[0]).unwrap();
        assert!(g.done && g.tick <= MAX_TICKS);
    }
}
