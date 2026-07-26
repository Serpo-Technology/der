#!/bin/sh
# Builds the C part into the zero-import wasm module the DER host runs.
# Needs clang with the wasm32 backend and wasm-ld (brew install lld).
set -e
cd "$(dirname "$0")"
WASM_LD="${WASM_LD:-/opt/homebrew/bin/wasm-ld}"

clang --target=wasm32-unknown-unknown -nostdlib -Oz -ffreestanding \
  -fno-builtin-memcpy -fno-builtin-memset \
  -Iinclude -DNDEBUG -c src/part.c -o build-part.o
clang --target=wasm32-unknown-unknown -nostdlib -Oz -ffreestanding \
  -fno-builtin-memcpy -fno-builtin-memset \
  -Iinclude -DNDEBUG -c vendor/qrcodegen.c -o build-qrcodegen.o
"$WASM_LD" --no-entry --export=der_alloc --export=der_run --export-memory \
  -z stack-size=131072 \
  build-part.o build-qrcodegen.o -o qr.wasm
rm -f build-part.o build-qrcodegen.o
echo "wrote qr.wasm ($(wc -c < qr.wasm | tr -d ' ') bytes)"
