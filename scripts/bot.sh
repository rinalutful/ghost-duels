#!/usr/bin/env bash
# The bot measurements behind docs/decisions/0008 (needs Rust; about 5 minutes on one core):
# the judge's beam search with the whole cave known, the same search planning 0.5 s and 1.0 s ahead
# (what's on screen), and the human model. Writes docs/evidence/bot/*.txt; each ends in a SUMMARY.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
( cd bot && cargo build --release -q )
B="$CARGO_TARGET_DIR/release/ghost-bot"
mkdir -p docs/evidence/bot
"$B" full 40 512 > docs/evidence/bot/full.txt
"$B" horizon 0 40 512 > docs/evidence/bot/plan-0.5s.txt
"$B" horizon 30 40 512 > docs/evidence/bot/plan-1.0s.txt
"$B" human 300 > docs/evidence/bot/human.txt
tail -qn1 docs/evidence/bot/*.txt
