#!/usr/bin/env bash
# Build the game's two wasm front-ends and copy them to res/ (and the browser one to web/public/):
#   res/ghost_sim_web.wasm      wasm32-unknown-unknown, what the browser plays
#   res/ghost_replay_job.wasm   wasm32-wasip2, what the replay job (TEE / runner) executes
# Pass --contracts to also build the contracts (Rust 1.93, cargo-near) into res/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
( cd game
  cargo build --release -p ghost-sim-web --target wasm32-unknown-unknown
  cargo build --release -p ghost-replay-job --target wasm32-wasip2 )
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/ghost_sim_web.wasm" res/
cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/ghost-replay-job.wasm" res/ghost_replay_job.wasm
mkdir -p web/public && cp res/ghost_sim_web.wasm web/public/
if [[ "${1:-}" == "--contracts" ]]; then
  ( cd contracts
    rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true # the pinned toolchain's, for cargo-near
    for c in ghost-duels mock-outlayer; do
      ( cd "$c" && cargo near build non-reproducible-wasm --no-abi --no-locked >/dev/null 2>&1 || cargo near build non-reproducible-wasm --no-abi )
    done )
  cp "$CARGO_TARGET_DIR/near/ghost_duels/ghost_duels.wasm" res/ 2>/dev/null || cp contracts/target/near/ghost_duels/ghost_duels.wasm res/
  cp "$CARGO_TARGET_DIR/near/mock_outlayer/mock_outlayer.wasm" res/ 2>/dev/null || cp contracts/target/near/mock_outlayer/mock_outlayer.wasm res/
  # Storage costs about 1 NEAR per 100 KB: shrink the contract (the sandbox and testnet run these bytes).
  if command -v wasm-opt >/dev/null; then
    wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --strip-debug --strip-producers res/ghost_duels.wasm -o res/ghost_duels.wasm
  fi
fi
( cd res && shasum -a 256 *.wasm > SHA256SUMS && cat SHA256SUMS )
ls -la res/*.wasm
