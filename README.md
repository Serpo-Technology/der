# DER: Dynamic Experience Runtime

DER is a post-app platform. Developers publish small signed parts instead
of finished apps, and DER builds the app you need from them on demand. You
describe what you want in a sentence. The app assembles in front of you out
of real native controls. The result behaves like installed software. It
lives in the tray, keeps its data, reopens where you left off, and can keep
refreshing in the background.

DER is built for every platform. Each one gets its own native interface over
the same Rust core. A web-based interface runs the same apps everywhere and
stays as a permanent fallback.

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
- The app is drawn live with real native controls while the model is still
  answering. On macOS this is SwiftUI today. A web-based renderer runs the
  same contract as a permanent second interface. It is also the fallback on
  any platform that does not have a native interface yet.
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

Two renderers, one semantics: the native and webview faces both render over
the same Rust runtime core. A committed conformance corpus of over two
hundred vectors runs against that core's source and against its WebAssembly
build, and the SwiftUI panel decodes the same view trees, so the faces stay
identical by construction.

## Status

Early and personal-scale. The native interface is the main experience on
every platform. macOS has the first one, built in SwiftUI. Other platforms
will get their own native interfaces over the same core, checked against the
same shared test cases. Until a platform has one, the web-based interface
runs there. It stays available afterward too. You bring your own model: a Claude subscription (built-in
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
cd platform/macos && swift build && cd ../..
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
cd platform/host && cargo test # Rust suites, conformance included
npm run eval -- --provider mercury   # generation + behavioral scoring
```

The conformance corpus under `runtime-conformance/` is the semantic
contract between renderers: change kernel behavior by regenerating vectors
(`npx tsx scripts/runtime-conformance/generate.ts`), reviewing the diff,
and making both suites pass. An implementation edit that fails a vector is
a drift bug. `CLAUDE.md` is the detailed architecture record.

## Roadmap

DER's host layer is already a capability system that happens to run in user
space. Every privileged thing an app can do leaves the runtime core through
one seam (`OperationDispatcher::dispatch`), and every grant the host hands
out is an unforgeable token scoped to one file, one endpoint, one
credential, or one app's store. The long-term direction is to run DER on a
capability microkernel such as seL4. There each grant becomes a kernel
capability and each host module becomes an isolated user-space server, so
the guarantees that careful Rust enforces inside one process today become
guarantees the kernel enforces even when a host module has a bug.

The runtime core carries over unchanged. Only `platform/host` is
redistributed into servers, and the contract format, the validator, and the
conformance vectors stay as they are.

### Stages

Each stage ships something usable on its own, and the conformance corpus is
the gate every time: a stage is done when the same vectors pass on the new
layout.

1. **Split the host.** Each host module becomes its own process on today's
   operating systems, and the processes talk over the same newline-delimited
   JSON protocol the native panel already speaks. This makes DER sturdier on
   macOS, brings Windows and Linux in, and is exactly the server layout the
   microkernel needs later. Gate: the corpus passes with the host split.
2. **Linux kiosk.** A minimal Linux boots straight into the DER shell and
   sandboxes every server with seccomp. Gate: a kiosk or classroom pilot.
3. **seL4 prototype.** A `no_std` runtime core runs under QEMU with the
   session, file, and store servers and the part runner. Gate: the corpus
   passes on seL4 in QEMU.
4. **DER OS.** Display, network, and installer servers join, along with a
   Linux personality and a VM fallback for foreign software.

The split in the first stage pays off before any kernel work starts. The
later stages swap the transport underneath and keep the design.

### The cut lines already exist

Five seams in the code separate pure logic from privilege. Each one is a
natural cut line for the port.

| Seam | Where | What it guarantees today |
| --- | --- | --- |
| `OperationDispatcher` | `runtime-core/src/session.rs` | The runtime core never performs IO. Every non-builtin operation leaves through one `dispatch()` call. |
| `RuntimeEnv` | `runtime-core/src/env.rs` | Ids, randomness, the clock, and the timezone reach operations only through four methods, so they can be scripted or real. |
| Wasm import gate | `platform/host/src/fragments.rs` | A part imports only what its declared, install-consented capabilities cover, which is nothing by default. Fuel, epoch, and memory limits bound every call. |
| File grants | `platform/host/src/files.rs` | Contracts never see paths. A pick mints an opaque token, reads accept only granted tokens, and saves go only through the save panel. |
| Per-app store | `platform/host/src/store.rs` | Collections live under `stores/<experienceId>/` and only the owning app reaches them. |

Two more host concerns sit beside these. The confined HTTP core injects a
credential only after checking the endpoint against the service's base URL,
and the panel protocol in `sidecar.rs` keeps the native renderer a pure view
that never holds a secret.

### Grants become capabilities

Every DER grant maps to a capability held by a session's process and invoked
over IPC. Nothing in the contract format changes.

| DER today | On a capability microkernel | Server |
| --- | --- | --- |
| Builtin operations and transforms | Pure computation inside the app's session process. No capability needed. | One session process per app |
| Clock, randomness, ids (`RuntimeEnv`) | Read-only endpoint capabilities | Time and entropy servers |
| Wasm compute part with zero imports | Its own process with an empty capability space. A CPU budget and a memory quota replace fuel and the memory limiter. | Part runner |
| `wasi:clocks`, `wasi:random` | The time or entropy capability, handed over at spawn | Part runner |
| `wasi:files` | Per-call capabilities to exactly the granted files, plus one fresh write-only output object | File server |
| `net:<host>:<port>` | A capability to one socket opened to that host and port. The part can name no other. | Network server |
| `file.pick` token | The pick dialog returns a file object capability, and the token becomes the capability itself | Trusted shell and file server |
| `file.save` through the save panel | The shell returns a write capability to the one location the user chose | Trusted shell and file server |
| `store.put`, `store.query`, `store.remove` | A capability to one store namespace, minted when the app's session opens | Store server |
| `http.get` and integration remotes | A capability to an HTTP client badged with one service's base URL. The server holds the secret and injects it. | HTTP and credential server |
| `email.send`, `email.list`, `email.fetch` | A capability to the mail server. Contracts never touch the account. | Mail server |
| LLM calls | A capability to an LLM gateway that only the composer holds. Apps and parts never get one. | LLM gateway |
| Native renderer over stdio | A display process holding one window surface per app and an IPC channel to its session | Display server |
| Part install, signature check, key pin | Only the installer may grant new part capabilities, and the signature check gates minting | Installer |

In the resulting layout, every line between layers is IPC on a capability.
A session process reaches only the servers, files, and endpoints its app
was granted.

```text
  DER apps                                   Foreign software
  (contracts + signed parts)                 (Linux, Windows via Wine, VMs)
        |                  |                            |
  Session processes   Part runners               Personality servers
  (runtime core,      (wasm parts, no            (translate foreign
   one per app)        capabilities by default)   system calls)
        |                  |                            |
  ---------------------- IPC on capabilities ----------------------
  System servers, each holding only the capabilities it needs:
  trusted shell, display, file, store, installer, network,
  HTTP + secrets, mail, LLM gateway, time + entropy
  ----------------------------------------------------------------
  Capability microkernel (seL4 or similar):
  IPC, capabilities, scheduling, memory isolation
```

### What changes in the code

Carries over unchanged:

- The runtime core (`der-runtime`). It is host-free by construction and
  needs only a Rust target for the new OS; `no_std` plus `alloc` is the
  likely ask, and `serde_json` already supports `alloc`.
- The conformance corpus in `runtime-conformance/`, which becomes the
  acceptance test for the port. A port is correct when the corpus passes.
- The panel protocol in `sidecar.rs` (`open`, `update`, `close` out;
  `setElement`, `dispatch`, `windowClosed` in), which becomes the IPC
  protocol between a session process and the display server.

Gets a new implementation:

- `HostDispatcher` (`platform/host/src/runtime/host.rs`) holds a Tauri app
  handle and calls modules in-process today. The new version holds a
  capability table for its session and turns each `dispatch()` into an IPC
  call on the matching capability. Its routing logic stays the same.
- `RuntimeEnv` gets a production implementation that calls the time and
  entropy endpoints.
- `FileGrants` loses its token-to-path map. A token becomes a handle to a
  file object capability held by the session, and the file server never
  exposes paths.
- The wasm part host runs each part in its own process so the kernel
  enforces isolation. Wasmtime stays as a second wall inside that process.
  The cost is a process spawn per part instance and an IPC hop per part
  call. The rules in `check_abi` become the rules for which capabilities a
  part's process receives at spawn.
- Credentials (`settings.rs`, `integrations.json`) move into a credential
  server that only the HTTP and mail servers can call.

Goes away on DER OS: Tauri, the webview window plumbing, and the tray. The
trusted shell and the display server take their place. The webview face
keeps running on every other platform, and on DER OS wherever a browser
engine is available.

### What gets stronger

The microkernel takes over enforcement of isolation. It does not make DER's
own judgment calls any safer.

Stronger:

- A bug in one host module no longer exposes the rest. Today a flaw in the
  mail code runs in the same process as the credential store and the file
  grants. As a server it can reach only its own capabilities.
- A compromised part runner cannot escalate. Wasmtime is the only wall
  today; on seL4 a formally verified kernel stands behind it.
- One app cannot read another app's store or files, even through a host
  bug, because its session never holds those capabilities.
- Grants become revocable at the kernel level. Closing a session or
  uninstalling a part revokes its capabilities everywhere at once.

Unchanged:

- What the user consents to. A part approved for `wasi:files` or a network
  endpoint at install gets it, so the install review stays the real
  security decision.
- What an integration does with data it is allowed to send. Confining
  requests to one service's base URL does not stop that service from
  misusing what it receives.
- Composition quality. Validation and the repair round still decide whether
  an app does what was asked.
- Foreign software. Linux, Windows, and VM compatibility layers sit beside
  DER as separate personalities. They gain sandboxing but none of DER's
  inspectability.

## License

DER (Dynamic Experience Runtime) was originally created by
Seyit Gokce. https://github.com/Serpo-Technology/der

DER is licensed under the GNU Affero General Public License, version 3 or later
(`LICENSE`), with additional terms in `NOTICE`:

- Copies and modified versions keep the attribution above.
- Parts written independently against the part interface may use any
  license. DER itself and the parts in this repository stay under the AGPL.
- Apps that DER generates are not covered by the AGPL.

To cite DER, use the metadata in `CITATION.cff`.
