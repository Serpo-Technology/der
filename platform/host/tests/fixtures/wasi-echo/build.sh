#!/bin/sh
# Builds the fixture to wasip1 and stages the committed artifact the
# capability tests load. Needs: rustup target add wasm32-wasip1
set -e
cd "$(dirname "$0")"
cargo build --target wasm32-wasip1 --release --quiet
cp target/wasm32-wasip1/release/wasi_echo.wasm ../wasi_echo.wasm
echo "wrote tests/fixtures/wasi_echo.wasm ($(wc -c < ../wasi_echo.wasm | tr -d ' ') bytes)"
