#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"

echo "building wasm32 engine…"
cargo build --release --target wasm32-unknown-unknown --features wasm -p engine --lib

OUT=web/src/pkg
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" \
  target/wasm32-unknown-unknown/release/engine.wasm

# wasm-bindgen emits .gitignore in the out dir; keep the files.
rm -f "$OUT/.gitignore"
echo "wasm bindings -> $OUT"
