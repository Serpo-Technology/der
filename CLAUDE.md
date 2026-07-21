# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Dynamic Experience Runtime (DER): a Tauri + React desktop app that turns natural-language
descriptions into interactive UIs through an AI-generated pipeline:
`Natural language -> Blueprint -> Contract -> rendered React Experience`. The React frontend
handles interpretation, editing, and rendering; the Rust backend handles storage, operation
execution, and window/tray management.

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

`AIInterpreterService` (`src/services/ai-interpreter/`) is the pipeline core, and generation is
LLM-first end to end: `NaturalLanguageParser.extractIntent` asks the model for intent JSON and
`ContractBuilder.generateFromBlueprint` asks it for the full contract, each validated against the
zod schemas in `src/schemas/` through `generateValidatedJson` (`llm-json.ts`), which runs one
repair round feeding validation errors back before failing. The contract prompt embeds the
component catalog (from `src/services/operations/registry.ts` plus repository custom ops) and the
runtime conventions. Post-processing dedupes ids, maps unknown element types to `container`, and
drops operations that are neither builtins nor carry a runnable implementation.
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

### Two persistence paths (gotcha)

Persistence is not unified. The TypeScript `PersistenceService` writes to SQLite
(`sqlite:der.db` via `@tauri-apps/plugin-sql`) with a filesystem fallback, while the Rust
commands in `lib.rs` write JSON files under the Tauri app data dir
(`experiences/`, `bookmarks/`, `contracts/`, `versions/`). Both are live: `MainInterface`
bookmark listing calls the Rust JSON path via `invoke('list_bookmarked_experiences')`, whereas
`IntegratedExperienceService` goes through the SQLite path. Check which side you are on before
adding storage behavior.

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
`anthropic` (API key), `deepseek`, `gemini`, `openai`, and `local` (OpenAI-compatible base URL).
Anthropic requests never send sampling parameters (modern Claude models reject them). Settings UI:
`src/components/settings/SettingsView.tsx`; TS wrappers: `src/services/settings/llm-settings.ts`.

### Runtime conventions

One flat state map with three namespaces: plain app-state keys (e.g. `todos`), `element_${id}`
for element values (inputs are auto-controlled and write there on change), and
`operation_${opId}` mirrors of operation results. Contracts may carry `initialState`.
`OperationExecutor` dispatches strictly on `executionType`: `builtin` runs real functions from
`src/services/operations/registry.ts` (todos.* own the `todos` array via ctx), `local` runs
`implementation.code` as a `(inputs, ctx)` function body, `remote` goes through Rust HTTP.
Input bindings resolve declaratively (`ui-element`/`state`/`constant`/`item`); list elements
repeat their children per bound item with an `item` binding scope, and event handlers pass the
clicked item to the executor. `normalizeContract` (`src/schemas/contract.ts`) converts legacy
`triggers` into event bindings before rendering.

### Component repository

The shared `repositoryService` singleton is seeded once at startup in `App.tsx` via
`registerBuiltins()` (`src/services/repository/builtins.ts`): UI elements (`button`, `text`,
`input`, `container`, `list`) plus operation manifests derived from the builtin registry
(`math.add`, `http.get`, `todos.add`, `todos.toggle`, `todos.remove`). Registration falls back to
the in-memory index outside Tauri instead of throwing.

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
