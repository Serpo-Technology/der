# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Dynamic Experience Runtime (DER): a Tauri + React desktop app that turns natural-language
descriptions into interactive UIs through an AI-generated pipeline:
`Natural language -> Contract (+ spec header) -> rendered Experience`, with the
reviewable Blueprint projected from that result. One Rust runtime kernel (`runtime-core/`)
owns interpretation, validation, and operation execution; the SwiftUI panel and the React
webview are parallel renderer faces over it, and the Rust backend also handles storage and
window/tray management.

The app lives at the repository root: `src/` is the webview face, `runtime-core/` the
kernel crate, and `platform/` the platform layer (`platform/host/` is the Rust core
process carrying the Tauri shell, host capabilities, and the bridge; `platform/macos/`
is the SwiftUI panel; further native faces join beside it). This file is the
authoritative architecture record; read the Architecture section before structural changes.

## Commands

```bash
npm run eval -- --provider mercury   # Generate the prompt suite (evals/prompts.json) and score end to end: compose + scripted behavior. --only <id> one prompt; --static-only skips behaviors
npm run eval:behave    # Rerun just the behaviors against the newest eval results (or EVAL_RESULTS=<path>)
npm run tauri dev      # Run the full desktop app (Rust backend + Vite frontend). Use this to exercise invoke().
npm run dev            # Vite frontend only on port 1420. Sessions and contract commands run over the in-process kernel; core-only capabilities (LLM, storage, parts, network) fail with a desktop-app message.
npm run build          # tsc (type-check, excludes tests) then vite build
npm run tauri build    # Build the packaged desktop app

npm run test           # vitest --run (one-shot)
npm run test:watch     # vitest watch mode
npm run type-check     # tsc --noEmit
npm run lint           # eslint (see lenience note below)
npm run format         # prettier --write over src

# Run a single test file or test by name:
npx vitest run src/models/__tests__/contract.test.ts
npx vitest run -t "substring of the test name"
```

Rust code under `platform/host/` is outside the ESLint/tsc setup; build it with `cargo` or the
`tauri` commands above.

## Architecture

### Intent and principles

DER turns a natural-language description into a working desktop app the user can keep, edit
conversationally, and launch like any installed app. Design principles: dynamic composition
(elements and operations compose at runtime, never at compile time); loose coupling through
manifests and contracts; the human keeps editorial control at every step (spec header,
Blueprint projection, contract editor); everything discoverable through the part registry;
contract changes render in real time; and composition only: the model never writes code, and
anything the parts cannot express is a repairable validation error, never a silent
degradation. The end goal is a marketplace of signed parts where service publishers ship
their own integrations.

Renderer direction, settled 2026-07-24: native rendering is DER's primary face, and the
webview is a permanent parallel renderer, never removed and never behind (it serves as
fallback, as a user preference, as coverage for platforms without a native renderer yet, and
as the basis for possible web versions). Assembling an experience live out of literal native
elements is a core differentiator; a webview assembling one reads as a page loading. macOS
is the first native platform; every further platform joins as another parallel renderer held
to the head. The conformance corpus is the enforcement mechanism: a vocabulary or semantics
change is complete only when every first-class renderer passes the shared vectors, so
renderers stay parallel by construction rather than by promise.

### Generation pipeline

The pipeline is `runtime/compose.rs` over the kernel's `compose` module; there is exactly one
implementation and every face calls it through commands. Creation is ONE model call:
`runtime_compose` asks for `{spec: {goal, assumptions, openQuestions}, contract}`
(`ComposedResponseSchema` structurally; `runtime/llm_schema.rs` semantically), validated
through `generate_validated_json`: structural validation plus the manifest checker, with one
repair round feeding all problems back before failing (two rounds on local/mercury).
When installed recipes exist, the catalog lists them under INSTALLED APPS and the same call may
answer `{spec, recipe: "<name>"}` instead of a contract (exactly one of the two; enforced by
the schema): the referenced recipe is validated in the semantic check (unknown or broken
references repair toward composing) and instantiated through finalization, with `recipeName`
surfaced on the composed result.
The webview reaches the pipeline through `src/services/runtime-core/compose-client.ts`
(`composeViaCore`/`editViaCore`/`generateFromBlueprintViaCore` wrap `runtime_compose`,
`runtime_edit_contract`, `runtime_generate_from_blueprint` and forward streaming partials from
the `runtime-compose-partial`/`runtime-edit-partial` events); `AIInterpreterService`
(`src/services/ai-interpreter/`) is a thin façade over those calls that refuses outside Tauri.
The Blueprint shown in the tabs is a projection (`BlueprintGenerator.deriveFromComposition`
in TS for display; `compose::derive_blueprint` for the native editors); blueprint regeneration
runs `runtime_generate_from_blueprint`, and spec assumptions/openQuestions surface as
informational warnings. The prompt is `build_base_prompt` (`runtime/prompt.rs`: shape, rules,
manifest catalog, example) as a cached system block shared by the create/blueprint/edit modes,
plus a short mode section block; the model is taught to omit empty arrays, defaults,
`executionType`, `layout`, `styling`, `metadata`, `triggers`, and empty-array seeds (the
checker seeds read-only array keys silently; null seeds still warn). Finalization dedupes ids,
maps unknown element types to `container`, resolves execution types, and fills the default
column layout, returning normalization warnings alongside the contract.
On streaming providers, creation opens the app window as soon as the first elements parse and
assembles it live: text deltas stream over a channel, `runtime/streaming.rs` shapes the growing
response into an inert display-only contract (operations and event bindings stripped; the
webview asks for the same extraction through `runtime_extract_streaming`), and
`IntegratedExperienceService` pushes it through `experience-contract-updated` until the
validated final contract replaces it. Non-streaming providers open the window when done.
Rendering happens over a core session in both faces (see Runtime kernel conformance).

### Orchestration and singletons

`IntegratedExperienceService` (exported as the singleton `integratedExperienceService`) wires
every subsystem together and is the entry point most UI flows call
(`createExperienceFromNaturalLanguage`, `editExperience`, `regenerateExperienceWithPreservation`,
share/bookmark/import). `DynamicExperienceRuntimeService` is also a singleton and keeps live
experience records in in-memory `Map`s keyed by `experienceId`; nothing there survives a
reload unless persisted. State and operations live in the core session behind each window,
not in these singletons.

### Frontend/backend boundary

The frontend reaches Rust through `@tauri-apps/api` `invoke`. `platform/host/src/lib.rs` registers the
commands (storage, `execute_operation`, window/tray control) plus the newer modules: `llm.rs`
(the `llm_chat` command that performs all LLM HTTP via reqwest), `settings.rs` (LLM settings and
credentials under `app_data_dir/settings/`, redacted reads), `oauth.rs` (Claude subscription
PKCE sign-in and token refresh), and `mail.rs` (the mail account in the credential store and the
`email_send`/`mail_list`/`mail_fetch`/`smtp_get`/`smtp_save`/`smtp_delete` commands). `execute_operation`'s `remote` branch performs real HTTP
(`{name}` endpoint substitution, GET query / JSON body, and named integration credentials:
`implementation.auth` references a credential stored under `settings/integrations.json`
(bearer/header/query kinds, a required service base URL the secret is CONFINED to, and optional
model-facing notes) that Rust injects at request time after checking the endpoint starts with
the base URL; the webview only sees redacted name/kind/target/baseUrl/notes views, the catalog
teaches names, base URLs, and notes so the model calls the real service, and validation rejects
unknown names and out-of-confinement endpoints); the `local` and `repository` branches in
Rust are legacy and unreachable from contracts. Rust `query_repository` still returns mock
components and is unused by the TS repository.
The contract commands the webview leans on: `runtime_check_contract` (structural schema plus
the manifest checker, string verdicts), `runtime_finalize_contract` (generation-path
normalization for stored shapes), `runtime_extract_streaming`, and `runtime_derive_blueprint`,
next to the session commands in `runtime/sessions.rs`.

### Persistence and the tray launcher

All persistence goes through the Rust commands in `lib.rs`, which write JSON files under the
Tauri app data dir: `experiences/`, `bookmarks/`, `experience_states/` (per-app state saved by
the standalone window, debounced), `contracts/`, `versions/`. The TypeScript `PersistenceService`
is a thin invoke wrapper; `parseMaybeJson` tolerates older double-encoded records. The tray menu
lists bookmarks as launchable apps: `bookmark_experience`/`delete_bookmarked_experience` rebuild
it (`rebuild_tray_menu`), and clicking an entry opens the experience window with its saved state
injected into `__DER_BOOTSTRAP.state`. An old `der.db` may exist in the app data dir; nothing
reads it.

### Two render entry points

`App.tsx` normally renders `MainInterface`, but if `window.__DER_BOOTSTRAP` is present it renders
a standalone `ExperienceWindow`/`LiveExperienceRenderer` instead. That global is injected by the
Rust `open_experience_window` command when opening an experience in its own OS window. Contract
changes propagate across windows via the Tauri event `experience-contract-updated`. The app
starts hidden and is driven from a macOS system tray whose menu emits `navigate-to-create` and
`show-bookmarks`, which `MainInterface` listens for.
Outside Tauri the same window opens experience links instead: a `#app=<base64url JSON>` hash
carries the contract, the id derives from the link so per-app state persists in localStorage,
and bookmark/native-window controls (core capabilities) stay hidden.

### models/ vs types/ (gotcha)

`src/types/*` are plain interfaces (data shapes). `src/models/*` are classes (`Blueprint`,
`Contract`) with `fromObject()` / `toObject()` used to hydrate and serialize across service and
IPC boundaries. Services constantly convert between the two, so a value may be either a plain
object or a model instance depending on where it came from. Calling model methods like
`.toObject()` on a plain interface object (or vice versa) is a common source of runtime errors.

### LLM providers

`LLMClient` (`src/services/ai-interpreter/llm-client.ts`) is a thin wrapper over the Tauri
`llm_chat` command; provider, model, and credentials resolve on the Rust side from stored
settings, so the webview never holds secrets and CORS does not apply. Providers:
`claude-subscription` (OAuth bearer + auto-refresh; sign-in lives in the Settings view),
`anthropic` (API key), `deepseek`, `gemini`, `openai`, `mercury` (Inception's diffusion models
behind an OpenAI-shaped API; response_format is never sent since diffusion serving may not
implement it), and `local` (OpenAI-compatible base URL).
Anthropic requests never send sampling parameters (modern Claude models reject them). `llm_chat`
accepts an optional `systemBlocks: [{text, cache}]` array: on Anthropic-shaped providers each
`cache: true` block gets `cache_control: {type: "ephemeral"}` (prompt caching for the static
prompt prefix; a legacy single system string is cached whole), while other providers receive the
blocks as one plain system message. Streaming goes through the separate `llm_chat_stream` command,
which takes a `Channel<String>`: Anthropic-shaped and OpenAI-shaped providers switch to SSE and
forward text deltas over the channel (Gemini stays non-streaming), with the full content still
returned at the end; plain `llm_chat` keeps its channel-less signature. Bare-origin
OpenAI-compatible base URLs (e.g. `http://localhost:11434`) normalize to `/v1`. Settings UI:
`src/components/settings/SettingsView.tsx`; TS wrappers: `src/services/settings/llm-settings.ts`.

### Composition-only part system

Architectural constraint: **the model never writes code**; it composes prewritten parts. The part
registry (`src/services/operations/registry.ts`) is the vocabulary's catalog: `ELEMENT_MANIFESTS`
(typed knobs, bindable props, howto, validated examples) and `BUILTIN_OPERATIONS` (generic
primitives `state.set`, `counter.add`, `list.append`/`updateWhere`/`removeWhere`/`toggleField`,
`math.add`, `time.now`, `http.get`; todos.* survive as hidden compat parts). These are
manifests only: no execute bodies live in TypeScript; the kernel implements every operation
and the registry snapshot (`runtime-conformance/registry.json`, generated from these tables)
is what the kernel compiles in. A `timer` element
ticks on an interval while rendered (visibleWhen gates double as pause buttons) and `textarea`
is a first-class labeled part. Structured inputs use dotted
prefixes (`item.<field>`, `set.<field>`, and part-declared ones like expr's `var.<name>`) grouped
by `assembleStructured`; fragment manifests may declare `structuredPrefixes`; `list.append`
generates ids itself. The transform vocabulary (`src/services/operations/transforms.ts`, also
metadata only) names the declarative derivations (`count`, `sum`, `filterBy`, `filterContains`,
`sortBy`, `pick`, `parseNumber`, `round`, `format`, `map`, ...) used by binding `transforms`
pipelines and `visibleWhen` conditions; transform parameter values may be live references
(`{"source": "state"|"element", "sourceId"}`) resolved against current state, which is how
search boxes and dynamic filters work. The
model's output schema rejects `local`/`implementation.code` as a parse error so the repair
round teaches it (`src/schemas/contract.ts` keeps the zod twin for webview-side structural
parses; the checker itself is `runtime/validation.rs`, reached from TS through
`runtime_check_contract`). Anything the parts cannot express (unknown operations, inputs,
outputs, transforms) is a hard error: the model recomposes or generation fails, never silently
ships less than asked. A wiring-completeness rule family (grown from behavioral eval findings) also
hard-errors dead compositions: expression identifiers without matching `var.*` bindings,
filters and sorts on fields a list's append never writes, filters driven by the same control
that feeds the append, operations nothing triggers, appended lists no list element displays,
list edits on keys nothing fills, and interactive controls nothing consumes. Row shapes are
first-class: an array output may declare `itemFields` in its manifest (the catalog renders it
as `array of {...}`), and item reads inside a list template (row bindings, row visibleWhen,
and item inputs of row-triggered operations) validate against the known shape, whether it
came from an append, a seed, or a declaring operation like `email.list`. Transform
conventions: `filterBy`/`filterContains` with an empty value keep everything (the "All"
dropdown case), and `pick` on an array reads its first entry (the filterBy-then-pick shape).
Per-row computed values use `deriveField` (backed by the kernel's `expression` module, a
synchronous evaluator with exactly the expr part's grammar): it adds an arithmetic field to
every row from that row's own fields, so row templates read it like any field and totals chain
deriveField then sum; validation parses every expression and checks its identifiers against
the fields the list's append actually writes, with fields derived mid-pipeline visible to
later steps.
Builtins also include `random.int`/`random.pick` (born when parts had no import grants;
kept because scripted-entropy vectors and part-free contracts both want them).
Warnings are cosmetic normalizations only (knob defaults, deduped inputs, seeded state keys);
the edit bar shows them grouped apart from spec assumptions and open questions. The `local`
execution type is sunset: sessions refuse `implementation.code` with a clear message, so
contracts compose parts everywhere, including hand-edited ones.

### Runtime conventions

One flat state map with three namespaces: plain app-state keys, `element_${id}` for element values
(inputs/selects/checkboxes are auto-controlled and write there on change, EXCEPT inside list
templates where controlled state would be shared across rows), and `operation_${opId}` mirrors.
Several bindings on one event run sequentially in contract order, and a failed operation stops
the rest of its chain (the error strip shows the root failure; later bindings usually consume
the failed operation's outputs). Buttons accept bound `content` as their label, the way list
row templates bind item fields onto row buttons.
Contracts may carry `initialState`. Constants can carry a typed `value` field (booleans/numbers);
`sourceId` stays the legacy string form. Elements support declarative `visibleWhen` conditions
(single or AND array; operators truthy/falsy/empty/notEmpty/equals/notEquals/gt/gte/lt/lte, with
optional transform pipelines; the comparison `value` is a literal or a live reference in the
transform-parameter grammar, resolved by both resolvers). Manifest knobs map to `type-knob-value` CSS classes via
`applyKnobs` in the renderer (invalid enum values normalize to the manifest default; `form`
elements take the container knobs). `contract.styling` picks an app-level look:
`theme` (`STYLE_THEMES` in the registry: default/dark/paper/terminal) and optional `accent`,
either a palette name (blue/green/violet/rose/amber/cyan, a `der-accent-*` class) or any
"#RRGGBB" color the model derives from the request (`accent-color.ts` computes the accent
trio as inline CSS variables; the native panel tints from the same value); the theme classes
drive the CSS variables in `experience.css`, the standalone window chrome and the native
windows follow the same look, and unknown values normalize with a warning. List
elements repeat children per bound item with an `item` binding scope and support an `emptyText`
knob. `normalizeContract` converts legacy `triggers` into event bindings before rendering.

### Signed parts (wasm, UI fragments, integrations)

Installed signed parts extend the vocabulary in four kinds: compute parts (wasm), composed UI
fragments (`uiFragments` templates, no wasm), integration parts (a `service` block plus
per-op `remote` specs, no wasm), and recipe parts (`recipes` entries, each a complete
behaviorally proven contract with title/description/keywords and its captured spec header; a
recipe bundle ships nothing but recipes). A fragment that also declares `operations` is a
partial-experience pack: its operation templates instantiate per use with the same `{{id}}`
scoping as template ids (state keys namespaced per instance, e.g. `<instance id>-elapsed`), so
a dropped-in pattern works with no outer wiring. Pack expansion happens where sessions and
views resolve (the kernel's `templates` module; `src/services/fragments/ui-fragments.ts`
keeps the TS expansion the models layer uses for id collection): instantiated operations
join the lookup, and the checker validates them through every existing rule on fresh copies
(pack paths name the instance), while the stored contract keeps only the compact instance
element. Pack operations compose the installed vocabulary by
name only; the verifier rejects an `implementation` on them, and the expansion strips one
defensively. The catalog marks such fragments self-wired and derives their state keys so
outer bindings can read them. Recipes publish into `FRAGMENT_RECIPES`;
`RecipeService` (`src/services/recipes/`) revalidates each contract through
`runtime_check_contract` (so a recipe whose parts are missing surfaces its problems instead
of rendering broken) and instantiates through `runtime_finalize_contract`;
`IntegratedExperienceService.createExperienceFromRecipe`
opens the result exactly like a generated app with no model call. The Parts view lists a
part's recipes with an Open button (unavailable ones disabled with the validation problems)
and the install review lists them under Apps. A `.derpart` bundle (verbatim-signed manifest + base64 wasm;
Ed25519 over `DERPART-SIG-V1\0 || manifest bytes`; wasm bound by `wasmSha256` in the manifest)
is verified and executed by the hardened wasmtime host in `platform/host/src/fragments.rs` (imports
gated by declared, install-consented capabilities, zero by default; wasi:clocks and
wasi:random exist today and execution links WASI with no ambient authority; fuel +
epoch deadline + memory limiter, fresh instance per call,
`der_alloc`/`der_run` JSON ABI). The compiled-module session cache revalidates against the
bundle bytes on disk, so an updated file swaps the guest without eviction choreography.
Operation names are namespaced with camelCase segments allowed (`date.diffDays` matches the
builtin `list.updateWhere` style). Integration calls run through `execute_part_remote`:
endpoint placeholders substitute percent-encoded, query values raw (reqwest encodes them),
redirects stay confined to the service base URL, a projection path that finds nothing fails the
call naming the path and the fields present, and part-scoped credentials (stored as
`part:<id>:<name>` in settings/integrations.json) inject host-side. Trust is pinned on first
install in `app_data_dir/fragments/trust.json` (publisher key fingerprints, namespace claims;
key changes hard-block). `FragmentsService` (`src/services/fragments/`) publishes installed
operations into `FRAGMENT_OPERATIONS` and templates into `FRAGMENT_ELEMENTS`; the Parts view
browses a static registry (an `index.json` generated by fragment-tool's `index` subcommand next
to the bundles), auto-checks a saved registry on open, and shows per-part update badges;
`fetch_registry_index`/`download_registry_bundle` in Rust are untrusted transport and the
signature/trust flow still judges installs. All operation lookups go through `getOperationDef()`
(builtins win collisions), so the prompt catalog, the checker, and the dispatchers
treat part operations exactly like builtins (the model still emits `executionType: "builtin"`).
Parts and the signing tool live in `fragments/` as standalone crates (NOT platform/host workspace
members); committed signed bundles keep `cargo test` hermetic; rebuilding needs
`rustup target add wasm32-unknown-unknown`. Current library: expr-evaluate and dates and
stats-summary and docs (markdownHtml/markdownText/textPdf/markdownPdf/docxText over a
minimal PDF writer) and imaging (info/resize/convert over the image crate, declaring
`io:large`) and archive (zip.list/extract/create) and qr (qr.encode, built in C against
the open ABI) and youtube (youtube.parse: any link form to embed/watch/thumbnail urls
plus t= timestamps) and webpage (page.blocks over io:large: a page's HTML to typed
readable blocks with boilerplate stripped and relative urls resolved; with http.get's
body output and a conditional-row list template this composes a native webpage reader
whose link rows refetch through item.href, proven by the webpage-reader eval) (compute),
frankfurter and openweather and coingecko and wikipedia
and mailer (Resend) (integrations),
ui-basics (entry_row, stat_tile, and the self-wired stopwatch pack), starter-apps (the
apps.expense_tracker, apps.calculator, and apps.webpage_reader recipes, proven in the
eval corpus; the reader recipe makes reader-shaped requests deterministic where fresh
composition of the two-chain wiring was stochastic). Compute
parts may declare the `io:large` capability (consented at install review) to raise the
wasm budgets to 32 MiB inputs, 512 MiB memory, and tenfold fuel for media payloads.
User-mediated file IO is a builtin layer in `platform/host/src/files.rs`, host-owned like
http.get: `file.pick` opens the system picker and grants a session token plus a
renderer URL (the asset protocol scope for the webview; the bridge rewrites granted
asset URLs to file URLs for the panel), `file.read` returns base64 plus UTF-8 text for
granted tokens only, and `file.save` writes solely through the save panel. Viewer
elements `pdf` and `video` (plus `image`) bind `src` from pick's `url` output: embed
and video tags in the webview, PDFKit and AVKit natively. The `video` element also
plays hosted embed urls (an exact-prefix allowlist of YouTube embed hosts, identical in
both faces: an iframe in the webview, and natively a navigation-confined WKWebView with
JavaScript on that loads the embed inside a shell document based on the embed host's
https origin, because the player demands an embedding context with a Referer and answers
a bare top-level load with its error 153), and the youtube part's `youtube.parse` turns
any pasted link form into that embed url, so "paste a link, press play" composes from an
input, the part, and the element (the youtube-player eval). The `html` element is the
rich-content viewer: its bound `content` string renders through an allowlist
sanitizer in the webview (`sanitize-html.ts`: formatting tags only, links keep text
and tooltip but never navigate, images data:/https only) and through a sealed
WKWebView natively (JavaScript off, every navigation cancelled); markdown previews
chain docs.markdownHtml into it (the markdown-preview eval). Converter apps are chains of
these small bits (pick, read, convert, save) wired through state, proven end to end by
the pdf-viewer, image-shrink, and md-to-pdf eval prompts with stubbed dialogs and real
wasm.
The per-app record store is the platform layer for data that outgrows the
state map: `store.put` / `store.query` / `store.remove` (`platform/host/src/store.rs`)
keep JSON collections under `stores/<experienceId>/`, confined to the owning
experience (the dispatcher carries the experience id; the webview executor
passes it via the operation context). put upserts by id (generated when
absent, structured `record.<field>` inputs), query filters one field (loose
equals or case-insensitive contains, empty keeps everything, mirroring the
transforms), sorts numeric-aware, and pages ({items, count, total}); rows
carry whatever fields puts wrote, so the row-shape checker skips such lists.
The notes-archive eval proves the class against an in-memory harness store.
The `email.*` builtins are the same pattern for mail (`platform/host/src/mail.rs`):
`email.send` (lettre over rustls), and the receive side `email.list` / `email.fetch`
(the imap crate over a rustls stream, implicit TLS only, usually port 993;
envelopes decode RFC 2047 words and bodies parse via mailparse, preferring
text/plain with a tag-stripped html fallback; fetching a message marks it read).
Operations name the CAPABILITY, never the protocol: contracts say "list my mail"
and the account record decides the transport, so recipes survive account changes
and future protocols (POP3, JMAP) arrive as new drivers behind the same three
operations. The mail account is one credential in the shared store (kind `smtp`,
name `mail`, in `settings/integrations.json` beside the HTTP and part-scoped
kinds: the password is the secret, the server details are its `fields`, including
`imapHost`/`imapPort` for incoming), with the standard redaction (both faces see
host/username/`hasPassword` views, an empty password on save keeps the stored one,
and a legacy `settings/smtp.json` migrates in on first read). Contracts supply
only message fields and ids. Setup happens in the app's own flow: an unconfigured
send or list opens the host-drawn account sheet natively (a `mailAccount` dialog
request next to pickFile/saveFile) and then continues, the webview face offers
"Set up email" on the error strip, and Settings reuses the same form as a row
beside the HTTP credentials (add/edit/remove). Only bearer/header/query
credentials are valid `implementation.auth` references and taught in the catalog;
smtp and part-scoped kinds are invisible there (frozen in a validation vector)
and refused at injection. Mail sits in the host platform layer next to the file
dialogs because the account credential, its redaction, and the in-flow setup sheet
are host concerns either way; socket-capable parts (a future wasi grant behind the
capability gate) would still not hold the account secret.
The mailer part (Resend API) stays the service-specific alternative and its howto
defers ordinary sending to the builtin; mailto links remain the zero-setup path.
The contact-email and mail-inbox evals prove the composition classes with stubbed
transports (`emailSent` expect; a fixture inbox behind provider seams).

### Runtime kernel conformance

The pure runtime kernel (transform semantics, the row-expression grammar, the builtin
operations with structured input assembly, sessions, view resolution, validation,
streaming recovery, and the compose orchestration) lives in the standalone `der-runtime`
crate (`runtime-core/`), host-free by construction, and it is the ONLY implementation:
the TypeScript twin is deleted. The desktop core links the crate natively
(`platform/host/src/runtime/` re-exports it and adds the host: dispatcher, live sessions,
sidecar, manage, schedule), and `runtime-wasm/` compiles the same crate to wasm32 behind
the parts' `der_alloc`/`der_run` envelope with one `env.host_call` import for dispatch
and entropy (`scripts/build-runtime-wasm.sh`; the artifact in `runtime-wasm/dist/` is
committed so the Node suites stay hermetic; `src/services/runtime-core/wasm-kernel.ts`
is the loader). Besides sessions, the wasm build exposes the kernel's pure functions as
capture operations (validation, streaming extraction, prompt rendering, schema parses,
finalization, the compose loop over scripted transports, `contract.check` for the human
checker, and `capture.judgeComposed` for eval scoring), which is how the vector
generator and the eval runner consume it under Node. Dispatched part operations get
their structured prefixes assembled by the dispatch hosts from the manifests'
`structuredPrefixes`. The corpus runner itself is shared (`runtime-core/src/vectors.rs`):
the cargo suite, the committed-artifact Node suite (`src/__tests__/kernel-vectors.test.ts`,
which catches a runtime-core edit that skipped the wasm rebuild), and the generator's
closing arbiter all drive the one implementation. Operations run
over an injected environment (scripted ids, randoms, and clock in vectors; real entropy in
production), `time.now`'s local date and time are asserted by shape so the corpus stays
timezone-independent, and `http.get` stays outside the kernel (network IO owned by the
host's confined HTTP path). `runtime/session.rs` runs whole experiences headlessly: state
initialization (initialState seeds, per-output `operation_<id>_<name>` placeholders, element
defaultValue seeds), declarative input resolution (ui-element/state/constant with the typed
value field/item scope, input pipelines with live parameter lookup), builtin execution, and
output routing with its settled quirks (output transforms run without live context,
a result missing an output's name routes the whole result, ui-element property outputs merge
a sub-object, `operation_` mirrors). Chains stop at the first failure with earlier writes
standing. Local code, remote endpoints, installed part operations, and http.get fail with a
resolution error in the session; the host dispatcher owns those.
The view layer: `runtime/view.rs` plus `runtime/templates.rs` resolve visibility, bindings,
list rows with item scopes, control values, event tables, and fragment expansion into a
renderer-agnostic tree under the protocol's JSON-value semantics (object keys holding null
and absent keys are equivalent; missing state reads stay distinct from null in numeric
comparisons). A resolved tree plus the session is everything a renderer backend needs;
`src/services/runtime-view/resolve-view.ts` keeps only the tree's TypeScript types.
The webview's experience windows are protocol clients: `CoreExperienceRenderer` (over
`src/services/runtime-core/session-client.ts`, a FIFO-serialized invoke
wrapper mirroring stdio ordering) opens a core session, renders its resolved
trees through the React presentation layer (`ComponentRenderer.renderResolvedNode`,
which holds only components, knob classes, and handler wiring),
dispatches chains one operation per call so the chain-stop rule stays with
the core (EventOutcome carries the failure message for the error strip), and
overlays local control values over async echoes until a dispatch lands.
`LiveExperienceRenderer` wraps it for the standalone window. Outside Tauri
(`npm run dev`, a plain browser) the face stays self-sufficient:
`main.tsx` installs the browser core before the first render
(`src/services/runtime-core/browser-core.ts` loads the committed kernel
wasm as a vite asset and serves the session transport plus the contract
commands through `core-invoke.ts`, the invoke-or-router seam every
command call site uses), builtins run in-kernel, and host-owned
operations (http.get, files, mail, store, installed parts) fail their
chain with a message naming the desktop app. jsdom suites that need
semantics route invoke to the wasm kernel through
`src/test/kernel-invoke.ts`. The dispatcher seam
(`runtime/session.rs` trait, `runtime/host.rs` implementation) routes non-builtin operations
to the machinery that already runs them: wasm parts in the wasmtime host, integration part
remotes through the signed service path, contract remotes and `http.get` through the shared
confined HTTP core extracted from `execute_operation` (credential injection and confinement
live in one place; local code stays webview-only). Ids, randomness, and the clock reach
operations only through the `RuntimeEnv` trait (`runtime/env.rs`): scripted in vectors, real
in production. `runtime/sessions.rs` is the live-session surface: `runtime_open_session`
(pack operations instantiated, installed fragment defs and part routes loaded from the
manifests on disk, saved data merged), `runtime_resolve_view`, `runtime_set_element`,
`runtime_dispatch_event` (off the async core threads), `runtime_close_session`; its
host-free cores are integration-tested by driving the committed stopwatch pack natively.
`runtime/schedule.rs` is background refresh: a bookmarked app can opt in
(the home row's context menu natively, the bookmark card in the webview; a
`backgroundMinutes` field on the bookmark record) and the core then runs the
app's visible timer tick chains once per cadence in a headless session (saved
state in, timer beats, state persisted back), skipping apps with an open
native window because their renderer owns the timers. The timer element is
the app's own declaration of periodic work, so no new vocabulary exists for
this; the timer howto teaches minutes-scale refresh timers.
`runtime/sidecar.rs` renders experiences in external panel
processes: the bridge owns the sessions, speaks newline-delimited JSON over the panel's
stdio (`open`/`update`/`close` out; `setElement`/`dispatch`/`windowClosed` in), and answers
every user action with a fresh tree; the panel is a pure view and secrets never leave the
host. `platform/macos/` is the SwiftUI panel (SwiftPM, built with `swift build`, found via
`DER_NATIVE_RENDERER` or the dev build path); the standalone experience window shows a
"Native window" button on macOS. `swift test` decodes the committed view vectors, holding
the panel's protocol types to the same trees as the other two resolvers. Native mode
(`--native` or `DER_NATIVE_MODE=1`; the standalone panel binary launches the app this way)
makes native the default: `open_experience_window_impl` routes every open to the panel with
saved state restored (restored data beats placeholders and element defaults, the webview's
merge order), the bridge persists per-app state after every action, and
`native_update_experience_contract` lands edits in open native windows with state
preserved. Creation is fully native and streams its assembly: the home's create runs
`native_create` (the Rust compose pipeline over the streaming transport; `llm_chat`'s chunk
plumbing is a callback sink the stream command wraps its webview channel around, and the
compose loop's throttled on_partial mirrors the webview cadence), every parseable partial
lands in the experience's assembly window as a display-only draft (`show_assembly_preview`
opens on the first and replaces on the rest; the open/update protocol carries an
`assembling` flag the panel renders as a building bar with input held; drafts never persist
state, a failed generation closes them, and a draft the user closes stays closed while the
finished app still opens), and the finished contract takes the window over live, with the
experience record saved for the home's Recent list. Ready-made apps open through
`native_open_recipe` the same way, and webview-initiated creates in native mode stream into
the same assembly windows through per-tick assembling opens. The panel's home is DER's
front door: branding, the create field with lifecycle status, bookmarked apps (context-menu
removable), recent creations, installed ready-made apps, and Settings/Parts buttons.
The two faces are peers: native mode never creates a webview window (the main window is
built programmatically in setup only outside native mode; `tauri.conf.json` declares no
windows), and everything the native face needs is native. `runtime/manage.rs` serves the
management surfaces over the panel protocol as snapshot messages and action events, pure
plumbing over the existing cores: LLM settings and redacted credentials, the Claude PKCE
sign-in, integration credentials, the mail account (redacted snapshot, `smtpSave`/`smtpRemove`),
the parts registry (saved URL under
`settings/registry.json`, update badges), the two-phase install review (stage summary with
publisher fingerprint pinning and downgrade consent, then commit), part removal, part
secrets, and recipe opens. Native app windows carry a bottom edit bar
(`editExperience` runs the Rust edit pipeline: `compose::edit_contract` ports the edit
mode with the id-stability rules and EDIT_REMOVED_PART warnings, the record updates, and
the session rebuilds with state preserved under an `editStatus` lifecycle), a bookmark
star wired to the tray and home, and an Editor button opening the native editors: the
contract as JSON validated and applied through `compose::check_contract_json` (structural
schema plus the manifest checker, verdicts listing every path and message), and the
blueprint projection (`compose::derive_blueprint`) whose edited plan regenerates the
contract through `compose::generate_from_blueprint` (blueprint mode over the same loop),
both landing with state preserved. The home reads the detailed bookmarks list, refreshes
without raising its window (`raise` on the home message; only explicit opens front it),
and shows example prompt chips when the create field is empty. First run is guided:
the home message carries `llmReady` (`settings::llm_ready`: subscription signed in,
an API key for the provider, or a local base URL) and while false the header shows a
setup card pointing at Settings with creation disabled; every settings save, key
change, and sign-in refreshes the home so the card clears the moment a model works.
Bookmark rows also expose the background-refresh toggle in their context menu. The panel is the app's face on macOS: regular activation policy (Dock and
menu bar identity from the DER.app bundle, so the packaged app shows the DER name and
icon), a full menu bar (Settings, Parts, Home, New App, Edit, Window) whose picks travel
as bridge events, Dock reopen shows the home, and quitting sends `quitApp` so the core
exits and the panel follows on stdin EOF. The core runs as an accessory in native mode
(tray only, no second Dock icon) and prevents exit while windowless, so DER persists in
the background. File dialogs in native mode are PRESENTED BY THE PANEL (`pickFile`/
`saveFile` request-reply over the protocol with a pending map in the core; panel events
run on a sequential worker thread so a dialog-blocked chain never deadlocks the reader);
the webview face keeps the dialog plugin. `scripts/package-macos.sh` builds the installable app:
the panel compiles in release mode, stages under `platform/host/binaries/` (gitignored), and
`tauri build --config platform/host/tauri.macos-app.conf.json` bundles it as an externalBin in
DER.app; a packaged build with the bundled panel runs native-first by default
(`DER_NATIVE_MODE=0` opts out), while dev builds stay webview-first behind the flag.
`runtime/streaming.rs` is the truncated-stream recovery (UTF-16 indices) and the
display-only contract extraction, with the transform-name filter spanning the full
registry including the presentation transforms the kernel does not execute.
`runtime/validation.rs` is the manifest checker: every rule family (transform pipelines
and param refs, list-field
reads with deriveField growth, knob and styling normalization, operation input/output
manifest checks with in-place dedup, expr.evaluate lint, placeholder endpoints and
credential confinement, fragment params and pack-operation merging, orphan/dead-control/
display rules, the seed pass), with its error paths, codes, and message text frozen by the
validation vectors because those messages feed the repair round. It reads the
part vocabulary two ways: `runtime/manifests.rs` embeds `runtime-conformance/registry.json`
(knob tables, builtin shapes, transform kinds, expr reserved words, generated from the
registry catalog by the vector generator) at compile time, and installed vocabulary
(fragment defs, part operations, credentials) is passed per check; serde_json runs with
`preserve_order` so object iteration matches JS insertion order in message text.
Validation vectors freeze {errors, warnings, mutated contract} per fixture, with each
fixture's installed vocabulary carried alongside.
The compose orchestration sits on top: `runtime/prompt.rs` renders
the base prompt and catalog (the registry snapshot carries the full
model-facing manifest text; installed vocabulary, credentials, and validated recipes arrive
per call), `runtime/llm_schema.rs` validates the model's response shape (issue paths,
zod-v4-flavored message text, default filling, snippet context, and the five-issue cap all
frozen by vectors), and `runtime/compose.rs` runs composition: the semantic gate (recipe
resolution or the checker), finalization (id dedup, type degradation, executionType
resolution, layout fill, metadata stamping, trigger normalization), and the repair loop
over a `ComposeLlm` transport trait (one repair round, two on local/mercury, the exact
repair-message and failure text). Compose vectors freeze prompt text, response verdicts,
finalized contracts (stamps masked), and the loop's full conversation protocol over
scripted responses. The
`runtime_compose` command is the host entry: vocabulary from the installed manifests on
disk, the real transport backed by `llm_chat`, one call from description to finalized
contract with no webview involved (`tests/runtime_compose_native.rs` proves compose ->
session -> resolved tree end to end, recipe reuse and the repair round included).
The committed vectors in `runtime-conformance/` are
the semantic contract: the cargo suite (`runtime_conformance.rs`) runs them against the
sources, `kernel-vectors.test.ts` runs them against the committed wasm artifact, and the
generator's arbiter runs them at regeneration time, covering the
JavaScript-flavored edges (Math.round at negative halves, toFixed strings, loose equality,
string coercions, stable sort fallbacks), with undefined normalizing to null because JSON is
what crosses the renderer boundary. To change kernel semantics: edit `runtime-core`, update
the generator's expectations if the change is intentional, regenerate the vectors
(`scripts/build-runtime-wasm.sh`, then `npx tsx scripts/runtime-conformance/generate.ts`),
review the diff, and make the suites pass; an implementation edit that fails a vector is a
drift bug, never a test to update. The generator authors every expectation by calling the
kernel itself (its `capture.*` operations), so the corpus records what the kernel does and
the review burden is the diff, not a re-derivation.
`formatNumber` and `formatDate` stay outside the kernel: their output is locale presentation
owned by whichever renderer displays the value.

### Component repository

The shared `repositoryService` singleton is seeded once at startup in `App.tsx` via
`registerBuiltins()` (`src/services/repository/builtins.ts`); both element and operation manifests
derive from the part registry. Registration falls back to the in-memory index outside Tauri
instead of throwing.

### Evals

`npm run eval -- --provider <p>` (scripts/eval/run.ts) generates every prompt in
`evals/prompts.json`, judges each first attempt with the real pipeline validation, then chains
into the behavioral stage: it spawns `vitest run --config vitest.evals.config.ts` against the
fresh results file and merges outcomes into it, printing one end-to-end score. The behavioral
harness (`evals/behavior.eval.tsx` + `evals/harness/`) executes each passing contract in the
runtime kernel's wasm build (a fresh kernel per scenario over the session-client transport
seam) and renders its resolved trees through the real React presentation under jsdom,
running the prompt's `behavior` script: steps address controls by fuzzy hints (generated
ids and labels vary), compute parts execute their actual wasm synchronously inside the
kernel's host_call, and remote parts return the scenario's `stubs`; the platform stubs
(dialogs, mail, store) are synchronous cores in `evals/harness/file-stubs.ts`. Behavioral
runs therefore prove the exact semantics the desktop core ships. The static judge is the
kernel too: the runner builds its prompt from `capture.promptBase`/`capture.promptSections`
and scores each response with `capture.judgeComposed` (parse, schema, recipe or manifest
gate, finalization), so eval verdicts and the app's repair loop can never disagree.
Prompts may carry `expectRecipe`: the correct answer reuses that installed recipe
(a composed contract scores `no-reuse`, the wrong or unexpected recipe `recipe-mismatch`), and
a correct reuse feeds the recipe's stored contract through the behavior stage so reuse must
also behave as the prompt demands. Results files (`evals/results-*.json`) store the generated
contracts plus behavior verdicts and are committed on purpose: they are the corpus of
behaviorally proven contracts.
Mercury occasionally emits unclosed JSON (an unparseable verdict); rerun the prompt with
`--only <id>` before treating it as a regression. The behavioral suite never runs under
`npm run test` (its own vitest config; failures grade model output, never the codebase).

## Conventions and gotchas

- Imports are relative throughout. The `@/`, `@/types`, `@/interfaces` aliases exist in
  `vite.config.ts` and `tsconfig.json` but are unused; match the surrounding relative style.
- Linting is deliberately lenient: `npm run lint` allows up to 295 warnings (a ratchet just above
  the legacy `no-explicit-any` count; lower it as warnings get fixed), and `no-explicit-any` plus
  the react-refresh rule are warnings. Unused vars/args/caught errors are errors unless prefixed
  with `_`. Do not treat a clean lint run as zero warnings.
- `tsconfig.json` excludes all `__tests__`/`test`/`tests` dirs, so type errors in test files do
  not fail `npm run build`. Run `npm run test` to check them.
- The global test setup (`src/test/setup.ts`) only registers `@testing-library/jest-dom`. There
  is no global Tauri or SQLite mock, so any test exercising `invoke` or `Database` must stub them
  itself. Suites that need real contract validation or finalization under jsdom mock invoke
  with `src/test/kernel-invoke.ts`, which serves those commands from the kernel's wasm build.
- Tests use Vitest + React Testing Library under jsdom, colocated in `__tests__/` next to source;
  broader integration/acceptance/performance suites live in `src/__tests__/`.
