# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Dynamic Experience Runtime (DER): a Tauri + React desktop app that turns natural-language
descriptions into interactive UIs through an AI-generated pipeline:
`Natural language -> Contract (+ spec header) -> rendered React Experience`, with the
reviewable Blueprint projected from that result. The React frontend handles interpretation,
editing, and rendering; the Rust backend handles storage, operation execution, and
window/tray management.

The app itself lives at the repository root (`src/`, `src-tauri/`). The `.kiro/specs/` tree is
the authoritative source for intent and architecture; read
`.kiro/specs/dynamic-experience-runtime/design.md` before making structural changes.

## Commands

```bash
npm run tauri dev      # Run the full desktop app (Rust backend + Vite frontend). Use this to exercise invoke().
npm run dev            # Vite frontend only on port 1420. Tauri invoke() calls fail here (no Rust backend).
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

Rust code under `src-tauri/` is outside the ESLint/tsc setup; build it with `cargo` or the
`tauri` commands above.

## Architecture

### Generation pipeline

`AIInterpreterService` (`src/services/ai-interpreter/`) is the pipeline core. Creation is ONE
model call: `compose` -> `ContractBuilder.composeFromDescription` asks for
`{spec: {goal, assumptions, openQuestions}, contract}` (`ComposedResponseSchema`), validated
through `generateValidatedJson` (`llm-json.ts`): zod structural validation plus a semantic
`checkAgainstManifests` pass, with one repair round feeding all problems back before failing.
The Blueprint shown in the tabs is a projection (`BlueprintGenerator.deriveFromComposition`);
the tab's regenerate path still uses `ContractBuilder.generateFromBlueprint`, and spec
assumptions/openQuestions surface as informational warnings. The prompt is
`buildBasePrompt(catalog)` (shape, rules, manifest catalog, example) as a cached system block
shared by the create/blueprint/edit modes, plus a short mode section block; the model is taught
to omit empty arrays, defaults, `executionType`, `layout`, `styling`, `metadata`, `triggers`,
and empty-array seeds (`checkAgainstManifests` seeds read-only array keys silently; null seeds
still warn). Post-processing dedupes ids, maps unknown element types to `container`, resolves
execution types, and fills the default column layout; normalization warnings are exposed via
`ContractBuilder.getLastWarnings()`.
On streaming providers, creation opens the app window as soon as the first elements parse and
assembles it live: `llm_chat` forwards text deltas over a Tauri channel, `parsePartialJson` /
`extractStreamingContract` (`partial-json.ts`) shape the growing response into an inert
display-only contract (operations and event bindings stripped), and
`IntegratedExperienceService` pushes it through `experience-contract-updated` until the
validated final contract replaces it. Non-streaming providers open the window when done.
`DynamicExperienceRenderer` -> `ComponentRenderer` then render the contract live, with
`ExperienceStateManager` holding per-experience state and `OperationExecutor` running operations.

### Orchestration and singletons

`IntegratedExperienceService` (exported as the singleton `integratedExperienceService`) wires
every subsystem together and is the entry point most UI flows call
(`createExperienceFromNaturalLanguage`, `editExperience`, `regenerateExperienceWithPreservation`,
share/bookmark/import). `DynamicExperienceRuntimeService` is also a singleton and keeps live
experiences and their state managers in in-memory `Map`s keyed by `experienceId`; nothing there
survives a reload unless persisted.

### Frontend/backend boundary

The frontend reaches Rust through `@tauri-apps/api` `invoke`. `src-tauri/src/lib.rs` registers the
commands (storage, `execute_operation`, window/tray control) plus three newer modules: `llm.rs`
(the `llm_chat` command that performs all LLM HTTP via reqwest), `settings.rs` (LLM settings and
credentials under `app_data_dir/settings/`, redacted reads), and `oauth.rs` (Claude subscription
PKCE sign-in and token refresh). `execute_operation`'s `remote` branch performs real HTTP
(`{name}` endpoint substitution, GET query / JSON body); the `local` and `repository` branches in
Rust are legacy and unreachable from contracts (the TS executor handles those). Rust
`query_repository` still returns mock components and is unused by the TS repository.

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
registry (`src/services/operations/registry.ts`) is the single source of truth: `ELEMENT_MANIFESTS`
(typed knobs, bindable props, howto, validated examples) and `BUILTIN_OPERATIONS` (generic
primitives `state.set`, `counter.add`, `list.append`/`updateWhere`/`removeWhere`/`toggleField`,
`math.add`, `time.now`, `http.get`; todos.* survive as hidden compat parts). A `timer` element
ticks on an interval while rendered (visibleWhen gates double as pause buttons) and `textarea`
is a first-class labeled part. Structured inputs use dotted
prefixes (`item.<field>`, `set.<field>`) grouped by `assembleStructured`; `list.append` generates
ids itself. The shared transform registry (`src/services/operations/transforms.ts`) provides the
declarative derivations (`count`, `sum`, `filterBy`, `filterContains`, `sortBy`, `pick`,
`parseNumber`, `round`, `format`, `map`, ...) used by binding `transforms` pipelines and
`visibleWhen` conditions; transform parameter values may be live references
(`{"source": "state"|"element", "sourceId"}`) resolved against current state, which is how
search boxes and dynamic filters work. The
model's output schema (`LlmContractSchema`) rejects `local`/`implementation.code` as a parse error
so the repair round teaches it; `checkAgainstManifests` (`src/schemas/contract.ts`) runs inside
the repair loop. Anything the parts cannot express (unknown operations, inputs, outputs,
transforms) is a hard error: the model recomposes or generation fails, never silently ships
less than asked. Warnings are cosmetic normalizations only (knob defaults, deduped inputs,
seeded state keys); the edit bar shows them grouped apart from spec assumptions and open
questions. The `local` execution type still runs for human-edited contracts only.

### Runtime conventions

One flat state map with three namespaces: plain app-state keys, `element_${id}` for element values
(inputs/selects/checkboxes are auto-controlled and write there on change, EXCEPT inside list
templates where controlled state would be shared across rows), and `operation_${opId}` mirrors.
Contracts may carry `initialState`. Constants can carry a typed `value` field (booleans/numbers);
`sourceId` stays the legacy string form. Elements support declarative `visibleWhen` conditions
(single or AND array; operators truthy/falsy/empty/notEmpty/equals/notEquals/gt/gte/lt/lte, with
optional transform pipelines). Manifest knobs map to `type-knob-value` CSS classes via
`applyKnobs` in the renderer (invalid enum values normalize to the manifest default; `form`
elements take the container knobs). `contract.styling` picks an app-level look:
`theme` (`STYLE_THEMES` in the registry: default/dark/paper/terminal) and optional `accent`
(blue/green/violet/rose/amber) become `der-theme-*`/`der-accent-*` classes driving the CSS
variables in `experience.css`; the standalone window chrome follows the same variables, and
unknown values normalize with a warning. List
elements repeat children per bound item with an `item` binding scope and support an `emptyText`
knob. `normalizeContract` converts legacy `triggers` into event bindings before rendering.

### Wasm fragment parts

Installed signed parts extend the operation vocabulary: a `.derpart` bundle (verbatim-signed
manifest + base64 wasm; Ed25519 over `DERPART-SIG-V1\0 || manifest bytes`) is verified and
executed by the hardened wasmtime host in `src-tauri/src/fragments.rs` (zero imports allowed,
fuel + epoch deadline + memory limiter, fresh instance per call, `der_alloc`/`der_run` JSON ABI).
Trust is pinned on first install in `app_data_dir/fragments/trust.json` (publisher key
fingerprints, namespace claims; key changes hard-block). `FragmentsService`
(`src/services/fragments/`) publishes installed operations into `FRAGMENT_OPERATIONS`; all
operation lookups go through `getOperationDef()` (builtins win collisions), so the prompt
catalog, `checkAgainstManifests`, and the executor treat part operations exactly like builtins
(the model still emits `executionType: "builtin"`). Demo part + signing tool live in
`fragments/` as standalone crates (NOT src-tauri workspace members); the committed signed bundle
keeps `cargo test` hermetic; rebuilding needs `rustup target add wasm32-unknown-unknown`.

### Component repository

The shared `repositoryService` singleton is seeded once at startup in `App.tsx` via
`registerBuiltins()` (`src/services/repository/builtins.ts`); both element and operation manifests
derive from the part registry. Registration falls back to the in-memory index outside Tauri
instead of throwing.

## Conventions and gotchas

- Imports are relative throughout. The `@/`, `@/types`, `@/interfaces` aliases exist in
  `vite.config.ts` and `tsconfig.json` but are unused; match the surrounding relative style.
- Linting is deliberately lenient: `npm run lint` allows up to 350 warnings (a ratchet just above
  the legacy `no-explicit-any` count; lower it as warnings get fixed), and `no-explicit-any` plus
  the react-refresh rule are warnings. Unused vars/args/caught errors are errors unless prefixed
  with `_`. Do not treat a clean lint run as zero warnings.
- `tsconfig.json` excludes all `__tests__`/`test`/`tests` dirs, so type errors in test files do
  not fail `npm run build`. Run `npm run test` to check them.
- The global test setup (`src/test/setup.ts`) only registers `@testing-library/jest-dom`. There
  is no global Tauri or SQLite mock, so any test exercising `invoke` or `Database` must stub them
  itself. For pipeline tests, `src/test/llm-mocks.ts` provides canned intent/contract JSON and a
  `routeLlmChat` router for mocking the `llm_chat` command.
- Tests use Vitest + React Testing Library under jsdom, colocated in `__tests__/` next to source;
  broader integration/acceptance/performance suites live in `src/__tests__/`.
