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

`AIInterpreterService` (`src/services/ai-interpreter/`) is the pipeline core:
`NaturalLanguageParser` (calls `LLMClient`) produces a `ParsedIntent`; `BlueprintGenerator`
turns that into a `Blueprint`; `ContractBuilder` resolves it against the component
`RepositoryService` into a `Contract`. `DynamicExperienceRuntimeService.renderExperience()`
then walks the contract's `elements` tree (`DynamicExperienceRenderer` -> `ComponentRenderer`)
into a live React component, with `ExperienceStateManager` holding per-experience state and
`OperationExecutor` running operations.

### Orchestration and singletons

`IntegratedExperienceService` (exported as the singleton `integratedExperienceService`) wires
every subsystem together and is the entry point most UI flows call
(`createExperienceFromNaturalLanguage`, `editExperience`, `regenerateExperienceWithPreservation`,
share/bookmark/import). `DynamicExperienceRuntimeService` is also a singleton and keeps live
experiences and their state managers in in-memory `Map`s keyed by `experienceId`; nothing there
survives a reload unless persisted.

### Frontend/backend boundary

The frontend reaches Rust through `@tauri-apps/api` `invoke`. `src-tauri/src/lib.rs` registers
roughly two dozen commands (storage, `execute_operation`, window/tray control) in its
`invoke_handler`. Be aware that several are stubs: `remote` and `repository` operation execution
return mock responses, and `local` operations only support a small allowlist
(`file_read`, `file_write`, `system_info`). `query_repository` also returns mock components.

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

### LLM client

`LLMClient` (`src/services/ai-interpreter/llm-client.ts`) supports `openai`, `anthropic`,
`gemini`, and `local` providers. The active generation path (`IntegratedExperienceService`) is
pinned to Gemini `gemini-2.0-flash`; `MainInterface` separately builds a `local`-provider client
that backs manual validation and contract regeneration steps.

### Component repository

`RepositoryService` plus `registerBuiltins()` (`src/services/repository/builtins.ts`) seed the
built-in UI elements (`button`, `text`, `input`, `container`, `list`) and operations
(`math.add`, `http.get`, `todos.add`, `todos.toggle`) that `ContractBuilder` resolves against.
`MainInterface` seeds these on mount.

## Conventions and gotchas

- Imports are relative throughout. The `@/`, `@/types`, `@/interfaces` aliases exist in
  `vite.config.ts` and `tsconfig.json` but are unused; match the surrounding relative style.
- Linting is deliberately lenient: `npm run lint` passes with up to 150 warnings, and
  `no-explicit-any` plus the react-refresh rule are warnings. Unused vars are errors unless
  prefixed with `_`. Do not treat a clean lint run as zero warnings.
- `tsconfig.json` excludes all `__tests__`/`test`/`tests` dirs, so type errors in test files do
  not fail `npm run build`. Run `npm run test` to check them.
- The global test setup (`src/test/setup.ts`) only registers `@testing-library/jest-dom`. There
  is no global Tauri or SQLite mock, so any test exercising `invoke` or `Database` must stub them
  itself.
- Tests use Vitest + React Testing Library under jsdom, colocated in `__tests__/` next to source;
  broader integration/acceptance/performance suites live in `src/__tests__/`.
