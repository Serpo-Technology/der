# Wasm parts

A part is a sandboxed WebAssembly module plus a signed manifest, shipped
together as a single `.derpart` file. The manifest describes the operations
the module provides (names, inputs, outputs, howto lines, and examples for
contract composition) and binds the module by its sha256. The app verifies
an Ed25519 signature over the verbatim manifest bytes before installing
anything, and the module itself may import nothing from the host: a v1 part
can compute values from its inputs and can do nothing else. It has no
access to the network, the file system, or any host function.

## Layout

- `fragment-tool/` is the publisher CLI. It generates Ed25519 key pairs,
  signs manifests, and packs `.derpart` bundles.
- `stats-summary/` is a demo part. It provides `stats.summary` (count,
  sum, mean, min, max) and `stats.percentile` (linear interpolation
  between closest ranks). Its `manifest.json` is the exact byte sequence
  that gets signed.
- `expr-evaluate/` is a demo part providing `expr.evaluate`: a safe
  arithmetic expression evaluator (+ - * / % ^, parentheses, unary minus,
  sqrt/abs/floor/ceil/round, two-argument min/max/pow, pi and e, and
  caller-bound variables via `var.<name>` inputs). It lets calculator and
  converter apps compute locally instead of calling a public API.
- `keys/` holds publisher keys. Only the public half (`demo.pub`) is
  tracked; the secret half (`demo.key`) is gitignored.
- `dist/` holds signed bundles ready to install through the app.

These crates are standalone. None of them belongs to a cargo workspace,
and none is part of the `src-tauri` build.

## Rebuilding the demo part

```
rustup target add wasm32-unknown-unknown
cd fragments/stats-summary
cargo build --release --target wasm32-unknown-unknown
```

The module lands at
`target/wasm32-unknown-unknown/release/stats_summary.wasm`. After any
change to the module, put its new hash into the `wasmSha256` field of
`manifest.json`:

```
shasum -a 256 target/wasm32-unknown-unknown/release/stats_summary.wasm
```

## Signing and bundling

From the repository root:

```
cargo run --manifest-path fragments/fragment-tool/Cargo.toml -- \
  bundle \
  --manifest fragments/stats-summary/manifest.json \
  --wasm fragments/stats-summary/target/wasm32-unknown-unknown/release/stats_summary.wasm \
  --key fragments/keys/demo.key \
  --out fragments/dist/der-labs.stats-summary.derpart
```

The tool refuses to sign when the manifest's `wasmSha256` does not match
the module, and it prints the hash to paste into the manifest. The
manifest bytes are embedded verbatim, so any edit to `manifest.json`
requires re-running the bundle step.

To create a new publisher key pair:

```
cargo run --manifest-path fragments/fragment-tool/Cargo.toml -- \
  keygen --out-dir fragments/keys --name demo
```

To print the fingerprint of a public key:

```
cargo run --manifest-path fragments/fragment-tool/Cargo.toml -- \
  fingerprint --pub fragments/keys/demo.pub
```

## Demo publisher

The demo publisher is `der-labs`. Its public key (`keys/demo.pub`,
base64 of the raw 32-byte Ed25519 key):

```
AD8PtMd23aBpv86MrPqTAOoH/kYFUJUZ/4t3CUs/iTc=
```

Fingerprint (sha256 of the raw public key), as the app displays it during
install:

```
d890 42e1 fc81 a0a3 1a29 a0bc 7785 4670 46f8 8878 802f 8660 0100 2416 f8cf 0e09
```

## Keep the secret key local

`keys/demo.key` is the signing secret. It is gitignored and must stay on
this machine only. Never commit it, copy it into a bundle, or share it:
anyone holding the file can sign parts that install under this publisher
identity. If the key ever leaks, generate a new pair and re-sign.
