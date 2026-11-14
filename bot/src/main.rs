//! The bot that beats Ghost Duels' humans, kept as a measurement tool (docs/decisions/0008).
//!
//! The beam search is adapted from the AI judge's probe (2026-11-06): it keeps the best `width`
//! states each tick, scored by gems, then by how close the ship stays to the cave's middle a little
//! ahead. Two ways to run it:
//!   - `full`: it knows the whole cave from the seed (the v1 contract handed out the seed at
//!     `start_run`, with 600 s to submit a 60 s run);
//!   - `horizon H`: receding horizon. It plans H + 30 ticks ahead of where it is, commits the first
//!     30 (0.5 s), and plans again. Up to about 70 ticks of plan (1.2 s at full speed), everything
//!     it needs is already on screen (the ship sits 248 px from the right edge), so this is a bot
//!     that knows only what a human sees. A cave revealed in segments by later blocks can't hide
//!     less than the screen;
//!   - `human`: a model of a decent human, not a search: every 4-6 ticks it looks at the cave 60 px
//!     ahead (with a slowly drifting aim error) and acts 8-11 ticks (130-180 ms) later. The same
//!     controller drives the page test and the demo video (demo/src/human.ts).
//!
//! Usage: ghost-bot <full|horizon> [H] [caves] [width]. Prints one line per cave, then a summary.
use ghost_sim::{replay, Game, COL_W, FP, MAX_TOGGLES, SHIP_X};
use std::collections::HashSet;

fn splitmix(z: &mut u64) -> u64 {
    *z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut x = *z;
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

fn eval(g: &Game, toggles: u32) -> i64 {
    if !g.alive {
        return i64::MIN / 2 + g.tick as i64;
    }
    let mut pen = 0i64;
    for look in [0, 8, 16, 32] {
        let k = ((g.cam() + SHIP_X + look) / COL_W) as u32;
        if let Some(c) = g.column(k) {
            let mid = (c.top as i32 + c.bot as i32) / 2 * FP;
            pen += ((g.y - mid).abs() as i64) / 4;
        }
    }
    g.gems as i64 * 1_000_000 - pen - toggles as i64 * 2
}

/// Beam search from `start` for at most `ticks` ticks (or to the end). Returns the held state for
/// each tick of the best line found.
fn beam(start: &Game, toggles0: u32, ticks: u32, width: usize) -> Vec<bool> {
    let mut hist: Vec<Vec<(u32, bool)>> = Vec::new();
    let mut beam: Vec<(Game, u32)> = vec![(start.clone(), toggles0)];
    for _ in 0..ticks {
        let mut next: Vec<(i64, Game, u32, u32, bool)> = Vec::with_capacity(beam.len() * 2);
        for (pi, (g, t)) in beam.iter().enumerate() {
            for held in [false, true] {
                if g.done {
                    if held == g.held {
                        next.push((eval(g, *t), g.clone(), *t, pi as u32, held));
                    }
                    continue;
                }
                let toggled = held != g.held;
                if toggled && *t as usize >= MAX_TOGGLES {
                    continue;
                }
                let mut n = g.clone();
                n.step(held);
                let nt = t + toggled as u32;
                next.push((eval(&n, nt), n, nt, pi as u32, held));
            }
        }
        next.sort_by(|a, b| b.0.cmp(&a.0));
        let mut seen = HashSet::new();
        let (mut lvl, mut nb) = (Vec::new(), Vec::new());
        for (_, g, t, p, h) in next {
            if !seen.insert((g.y / 64, g.vy / 16, g.held, g.gems, g.done)) {
                continue;
            }
            if nb.len() >= width {
                break;
            }
            lvl.push((p, h));
            nb.push((g, t));
        }
        hist.push(lvl);
        beam = nb;
        if beam.iter().all(|(g, _)| g.done) {
            break;
        }
    }
    // The best final node: alive and furthest/most gems, else the longest-lived.
    let best = (0..beam.len()).max_by_key(|&i| (beam[i].0.alive, beam[i].0.score(), eval(&beam[i].0, beam[i].1))).unwrap();
    let mut line = vec![false; hist.len()];
    let mut idx = best;
    for l in (0..hist.len()).rev() {
        let (p, h) = hist[l][idx];
        line[l] = h;
        idx = p as usize;
    }
    line
}

/// The human model (see the header). `r` is its own xorshift, seeded per cave.
fn human(seed: &[u8; 32], mut r: u64) -> Vec<u32> {
    let mut rnd = move || {
        r ^= r << 13;
        r ^= r >> 7;
        r ^= r << 17;
        (r >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut g = Game::new(seed);
    let mut log = vec![];
    let (mut held, mut bias, mut next_look) = (false, 0.0f64, 0u32);
    let mut queue: std::collections::VecDeque<(u32, bool)> = Default::default();
    while !g.done {
        if g.tick >= next_look {
            bias = bias * 0.9 + (rnd() - 0.5) * 6.0;
            let k = ((g.cam() + SHIP_X + 60) / COL_W) as u32;
            let mid = g.column(k).map_or(90.0, |c| (c.top as f64 + c.bot as f64) / 2.0) + bias;
            let want = (g.y as f64 + g.vy as f64 * 15.0) / FP as f64 > mid;
            queue.push_back((g.tick + 8 + (rnd() * 3.0) as u32, want));
            next_look = g.tick + 4 + (rnd() * 3.0) as u32;
        }
        while queue.front().is_some_and(|q| q.0 <= g.tick) {
            held = queue.pop_front().unwrap().1;
        }
        let h = if held != g.held && log.len() >= MAX_TOGGLES { g.held } else { held };
        if h != g.held {
            log.push(g.tick);
        }
        g.step(h);
    }
    log
}

/// Fly a cave. `horizon` None = full knowledge.
fn fly(seed: &[u8; 32], horizon: Option<u32>, width: usize) -> Vec<u32> {
    let mut g = Game::new(seed);
    let mut log = vec![];
    let commit = 30;
    while !g.done {
        let plan = match horizon {
            None => beam(&g, log.len() as u32, u32::MAX, width),
            Some(h) => beam(&g, log.len() as u32, h + commit, width),
        };
        let take = if horizon.is_none() { plan.len() } else { (commit as usize).min(plan.len()) };
        for &held in &plan[..take] {
            if g.done {
                break;
            }
            if held != g.held && log.len() < MAX_TOGGLES {
                log.push(g.tick);
            }
            let h = if log.len() >= MAX_TOGGLES && held != g.held { g.held } else { held };
            g.step(h);
        }
        if plan.is_empty() {
            let h = g.held;
            g.step(h);
        }
    }
    log
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(String::as_str).unwrap_or("full");
    let (horizon, rest) = if mode == "horizon" { (Some(a.get(2).and_then(|s| s.parse().ok()).unwrap_or(30)), 3) } else { (None, 2) };
    let caves: usize = a.get(rest).and_then(|s| s.parse().ok()).unwrap_or(40);
    let width: usize = a.get(rest + 1).and_then(|s| s.parse().ok()).unwrap_or(128);
    let mut z = 12345u64; // the judge's seed stream: the same caves as its bot300.txt
    let mut scores = vec![];
    let mut survived = 0;
    let t0 = std::time::Instant::now();
    for i in 0..caves {
        let mut seed = [0u8; 32];
        for c in seed.chunks_mut(8) {
            c.copy_from_slice(&splitmix(&mut z).to_le_bytes());
        }
        let t = std::time::Instant::now();
        let log = if mode == "human" { human(&seed, 0x2545_F491_4F6C_DD1D ^ i as u64) } else { fly(&seed, horizon, width) };
        let g = replay(&seed, &log).expect("a valid log");
        survived += g.survived() as u32;
        scores.push(g.score());
        println!("{i} seed={} score={} metres={} gems={} survived={} toggles={} secs={:.1}", hex(&seed), g.score(), g.metres(), g.gems, g.survived(), log.len(), t.elapsed().as_secs_f32());
    }
    scores.sort();
    let label = match (mode, horizon) {
        ("human", _) => "human model (reacts in 130-180 ms, no search)".to_string(),
        (_, Some(h)) => format!("plans {} ticks ({:.1} s) ahead", h + 30, (h + 30) as f32 / 60.0),
        _ => "full knowledge of the cave".to_string(),
    };
    println!(
        "SUMMARY {label}{}: {caves} caves, median {}, p10 {}, p90 {}, survived {survived}/{caves}, {:.1} s per cave",
        if mode == "human" { String::new() } else { format!(", beam width {width}") },
        scores[caves / 2],
        scores[caves / 10],
        scores[caves * 9 / 10],
        t0.elapsed().as_secs_f32() / caves as f32,
    );
}
