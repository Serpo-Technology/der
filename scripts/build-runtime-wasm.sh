#!/usr/bin/env bash
# Builds the runtime kernel for wasm32 and stages the committed artifact the
# Node suites and the browser face load. Requires:
#   rustup target add wasm32-unknown-unknown
set -euo pipefail
cd "$(dirname "$0")/.."

(cd runtime-wasm && cargo build --target wasm32-unknown-unknown --release)
mkdir -p runtime-wasm/dist
cp runtime-wasm/target/wasm32-unknown-unknown/release/der_runtime_kernel.wasm runtime-wasm/dist/
ls -la runtime-wasm/dist/der_runtime_kernel.wasm
