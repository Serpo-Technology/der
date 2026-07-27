# Wasm parts

A part is a sandboxed WebAssembly module plus a signed manifest, shipped
together as a single `.derpart` file. The manifest describes the operations
the module provides (names, inputs, outputs, howto lines, and examples for
contract composition) and binds the module by its sha256. The app verifies
an Ed25519 signature over the verbatim manifest bytes before installing
anything, and the module itself may import nothing from the host: a v1 part
can compute values from its inputs and can do nothing else. It has no
access to the network, the file system, or any host function. Operation
names live under the manifest's namespace (`date.diffDays` for namespace
`date`); segments start lowercase and may continue in camelCase, matching
the builtin vocabulary.

## The ABI is language-agnostic

A part is any wasm module with an empty import section exporting `memory`,
`der_alloc(i32)->i32`, and `der_run(i32,i32)->i64`, answering the JSON
envelope (`{"operation", "inputs"}` in, `{"ok": ...}` or `{"err": ...}`
packed as `(ptr << 32) | len` out). The toolchain does not matter: `qr/` is
written in C (clang + wasm-ld, `build.sh`), everything else here in Rust,
and any language that can meet that shape can publish parts.


## Layout

- `fragment-tool/` is the publisher CLI. It generates Ed25519 key pairs,
  signs manifests, and packs `.derpart` bundles.
- `stats-summary/` is a demo part. It provides `stats.summary` (count,
  sum, mean, min, max) and `stats.percentile` (linear interpolation
  between closest ranks). Its `manifest.json` is the exact byte sequence
  that gets signed.
- `openweather/` is a demo integration part: no wasm, a signed `service`
  block confining every call to `https://api.openweathermap.org`, a declared
  API-key requirement the Parts view prompts for, and `weather.current` as a
  typed operation with query templates and response projection. This is the
  shape service publishers would ship.
- `ui-basics/` is a demo part with no wasm at all: it ships composed UI
  fragments (`basics.entry_row`, `basics.stat_tile`), pure-JSON templates
  the renderer expands per instance with parameters. UI-only bundles carry
  an empty `wasmSha256` and are signed exactly like operation parts.
  `basics.stopwatch` is a partial-experience pack: a fragment that also
  ships `operations` templates, instantiated per use with the same `{{id}}`
  scoping as template ids, so one dropped-in element is a working stopwatch
  with no outer wiring. Its state keys (`<instance id>-elapsed`,
  `<instance id>-running`) are readable by the rest of the app. Pack
  operations compose installed operations by name; the verifier rejects an
  `implementation` on them.
- `expr-evaluate/` is a demo part providing `expr.evaluate`: a safe
  arithmetic expression evaluator (+ - * / % ^, parentheses, unary minus,
  sqrt/abs/floor/ceil/round, two-argument min/max/pow, pi and e, and
  caller-bound variables via `var.<name>` inputs). It lets calculator and
  converter apps compute locally instead of calling a public API.
- `dates/` provides `date.diffDays` and `date.addDays`: civil-calendar day
  arithmetic for countdowns and deadlines. Dates are `YYYY-MM-DD` (a full
  ISO timestamp also parses).
- `youtube/` provides `youtube.parse`: any YouTube link form (watch,
  youtu.be, shorts, live, a bare video id) becomes the embed url a video
  element plays, plus the watch and thumbnail urls and the link's `t=`
  start time in seconds.
- `webpage/` provides `page.blocks`: a fetched page's HTML becomes typed
  readable blocks (heading, paragraph, item, quote, code, image, link) in
  document order, with navigation chrome, scripts, and forms stripped,
  entities decoded, and relative urls resolved against the page url. A
  block that is mostly one link becomes a link block, which is how reader
  apps navigate. Declares `io:large` for real page sizes.
- `frankfurter/` is an integration part for the free Frankfurter exchange
  rate API (`fx.rate`, no credential).
- `coingecko/` is an integration part for CoinGecko spot prices
  (`crypto.price`, no credential).
- `wikipedia/` is an integration part for English Wikipedia article
  summaries (`wiki.summary`, no credential); its endpoint path substitutes
  the topic percent-encoded.
- `starter-apps/` is a demo recipe part: no wasm, no operations, just
  `recipes` entries that each carry a complete contract taken verbatim from
  the behaviorally proven eval corpus, plus a title, description, keywords,
  and the spec header captured when it was proven. The app revalidates the
  contract against the installed part vocabulary and instantiates it as a
  ready app with no model call. A recipe bundle ships nothing but recipes.
- `keys/` holds publisher keys. Only the public half (`demo.pub`) is
  tracked; the secret half (`demo.key`) is gitignored.
- `dist/` holds signed bundles ready to install through the app, plus the
  registry `index.json` the `index` subcommand generates from them. Host the
  directory on any static http(s) server and point the app's Parts view at
  the index URL to browse and install from it; bundle URLs in the index are
  relative to it. The registry is untrusted transport: installation is still
  judged by bundle signatures and the pinned trust store.

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
