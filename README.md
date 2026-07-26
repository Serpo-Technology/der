# DER: Dynamic Experience Runtime

DER is a macOS app that turns a sentence into a working desktop app. You
describe what you want, the app assembles in front of you out of real native
controls, and the result behaves like installed software: it lives in the
menu bar tray, keeps its data, reopens where you left off, and can keep
refreshing in the background.

The part most systems get wrong is the part DER is built around: **the AI
never writes code**. It composes prewritten, signed parts into a declarative
wiring that is validated before anything runs. A generated app is a JSON
document you can read, review, and edit, and it can only ever do what the
installed parts allow.

## How it works

- You describe an app. One model call returns a spec header (goal,
  assumptions, open questions) plus a contract: elements, operations, and
  the wiring between them, drawn from a catalog of installed parts.
- A validator checks every wire before anything runs: unknown operations,
  misspelled fields, dead controls, and unreachable data are hard errors
  that feed a repair round. Nothing silently ships less than you asked for.
- The runtime renders the contract live. On macOS that means literal native
  controls (SwiftUI) assembling while the model streams; a webview renderer
  runs the identical contract as a permanent parallel face.
- Apps persist: bookmark one and it becomes launchable from the tray, its
  state saved per app. Editing is conversational and preserves your data.

## The security model

Generated software normally means trusting generated code. DER removes that
trust question structurally:

- Compute parts are WebAssembly with zero imports. No network, no files, no
  clock, no randomness beyond what the host hands in. Any language that
  compiles to wasm can ship a part; the sandbox is the same.
- Network access exists only as declarations. Integration parts name their
  service and endpoints, requests are confined to the declared base URL, and
  credentials are injected by the host at request time. A contract holds
  credential names, never secrets.
- Files move only through user gestures: the system picker grants a token
  for exactly the chosen file, and saves go through the save panel.
- Mail, storage, and other privileged capabilities are host-owned
  operations with their own consent surfaces. Secrets live in one redacted
  credential store and never enter a generated app.
- Parts are signed. Installs verify Ed25519 signatures, pin the publisher's
  key on first use, and show a review of exactly what a part adds before
  anything lands.

Two renderers, one semantics: a committed conformance corpus of several
hundred vectors is run by both the TypeScript and Rust implementations, so
the native and webview faces stay identical by construction.

## Status

Early, macOS-first, and personal-scale. The native face is the primary
experience; the webview face is a permanent peer and the path to other
platforms. You bring your own model: a Claude subscription (built-in
sign-in), an API key (Anthropic, OpenAI, DeepSeek, Gemini, Mercury), or a
local OpenAI-compatible server such as Ollama.

## Build and run

Prerequisites: Rust (stable), Node 20+, Xcode command line tools, and
`rustup target add wasm32-unknown-unknown` if you rebuild parts.

```bash
npm install
npm run tauri dev          # webview-first development run
```

For the native face, build the panel once and run in native mode:

```bash
cd native/macos && swift build && cd ../..
DER_NATIVE_MODE=1 npm run tauri dev
```

A packaged, native-first DER.app comes from:

```bash
./scripts/package-macos.sh
```

On first launch, open Settings from the home screen and connect a model.
Then try:

```text
An expense tracker with categories, a filter dropdown, and a monthly total, dark violet theme
```

```text
A markdown previewer: I write markdown in a large text box, press Preview, and see the rendered result
```

```text
A permanent notes archive: I type a note and save it, the list shows every saved note, and a search field narrows it
```

## Parts

The installed vocabulary is the whole capability surface. The library in
`fragments/` currently covers expressions, dates, statistics, document
conversion (markdown, PDF, docx), imaging, zip archives, QR codes (written
in C against the open wasm ABI), currency, weather, prices, wikipedia, and
mail via Resend, plus UI packs and ready-made app recipes proven by the
behavioral eval suite.

`fragments/dist/` is a complete static registry: host `index.json` and the
bundles anywhere, point the Parts view at the URL, and installs still verify
signatures locally. See `fragments/keys/README.md` for publisher keys and
signing.

## Development

```bash
npm run test               # vitest suite
npm run type-check
cd src-tauri && cargo test # Rust suites, conformance included
npm run eval -- --provider mercury   # generation + behavioral scoring
```

The conformance corpus under `runtime-conformance/` is the semantic
contract between renderers: change kernel behavior by regenerating vectors
(`npx tsx scripts/runtime-conformance/generate.ts`), reviewing the diff,
and making both suites pass. An implementation edit that fails a vector is
a drift bug. `CLAUDE.md` is the detailed architecture record.

## License

Apache-2.0. See `LICENSE`.
