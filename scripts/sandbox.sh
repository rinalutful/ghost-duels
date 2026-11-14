#!/usr/bin/env bash
# Every path on a local NEAR sandbox (free, offline): the contract's unit tests, then the sandbox suite.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
command -v wasmtime >/dev/null || { echo "needs wasmtime: brew install wasmtime (or curl https://wasmtime.dev/install.sh -sSf | bash)"; exit 1; }
# NEAR's sandbox binary (the local node near-workspaces starts) is built against glibc 2.38.
if [[ "$(uname)" == Linux ]]; then
  g=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)
  if [[ "$(printf '%s\n2.38\n' "$g" | sort -V | head -1)" != 2.38 ]]; then
    echo "needs glibc 2.38 or newer for NEAR's sandbox binary (Ubuntu 24.04); this box has glibc $g"; exit 1
  fi
fi
( cd game && cargo test -q -p ghost-sim )
( cd contracts && cargo test -q -p ghost-duels )
( cd sandbox && cargo run -q ) | tee docs/evidence/sandbox.txt
