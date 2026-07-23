import "./App.css";
import { MainInterface } from "./components/MainInterface.tsx";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LiveExperienceRenderer } from "./components/runtime/LiveExperienceRenderer";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { Contract as ContractType, ValidationWarning } from "./types/contract";
import { ExperienceEditBar } from "./components/runtime/ExperienceEditBar";
import { integratedExperienceService } from "./services/IntegratedExperienceService";
import { persistenceService } from "./services/persistence";
import { fragmentsService } from "./services/fragments/FragmentsService";
import { repositoryService } from "./services/repository/repository-service";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { registerBuiltins } from "./services/repository/builtins";
import { STYLE_ACCENTS, STYLE_THEMES } from "./services/operations/registry";

function App() {
  // Seed the shared component catalog once at startup. Installed parts load
  // in every window: experience windows execute their operations too.
  useEffect(() => {
    registerBuiltins(repositoryService).catch((error) =>
      console.warn("Failed to register built-in components", error)
    );
    fragmentsService.init().catch((error) =>
      console.warn("Failed to load installed parts", error)
    );
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injected = (globalThis as any).__DER_BOOTSTRAP as
    | {
        experienceId?: string;
        contract?: ContractType | string;
        state?: Record<string, unknown> | null;
        assembling?: boolean;
      }
    | undefined;

  // Tolerate a double-encoded bootstrap contract from older windows.
  const injectedContract: ContractType | undefined =
    typeof injected?.contract === "string"
      ? (() => {
          try {
            return JSON.parse(injected.contract) as ContractType;
          } catch {
            return undefined;
          }
        })()
      : injected?.contract;

  const injectedState =
    injected?.state && typeof injected.state === "object" ? injected.state : undefined;

  if (injected?.experienceId && injectedContract) {
    return (
      <div className="app" style={{ width: "100%", height: "100%" }}>
        <ErrorBoundary fallback={<div style={{ padding: 16 }}>This window failed to render. Close it and reopen the experience.</div>}>
          <ExperienceWindow
            initialExperienceId={injected.experienceId}
            initialContract={injectedContract}
            savedState={injectedState}
            initialAssembling={Boolean(injected.assembling)}
          />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div className="app">
      <MainInterface />
    </div>
  );
}

const ExperienceWindow: React.FC<{
  initialExperienceId: string;
  initialContract: ContractType;
  savedState?: Record<string, unknown>;
  initialAssembling?: boolean;
}> = ({ initialExperienceId, initialContract, savedState, initialAssembling = false }) => {
  const [currentContract, setCurrentContract] = useState<ContractType>(initialContract);
  const [editBusy, setEditBusy] = useState(false);
  const [editProgress, setEditProgress] = useState<string | null>(null);
  const [editWarnings, setEditWarnings] = useState<ValidationWarning[]>([]);
  const [assembling, setAssembling] = useState(initialAssembling);
  const [assemblyFailed, setAssemblyFailed] = useState(false);
  const title = useMemo(() => currentContract.name || initialExperienceId, [currentContract.name, initialExperienceId]);

  // Persist the app's state so it survives closing the window. Writes are
  // debounced; the latest snapshot is flushed when the window goes away.
  const pendingState = React.useRef<Record<string, unknown> | null>(null);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestData = React.useRef<Record<string, unknown> | null>(null);

  // Rehydration data for the renderer: recomputed only when the contract
  // changes (an edit), carrying the live data across the remount.
  const rehydrationData = useMemo(
    () => ({ ...(savedState ?? {}), ...(latestData.current ?? {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentContract, savedState]
  );

  const flushState = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingState.current) {
      const snapshot = pendingState.current;
      pendingState.current = null;
      invoke("save_experience_state", { experienceId: initialExperienceId, state: snapshot }).catch(
        (error) => console.warn("Failed to save app state", error)
      );
    }
  }, [initialExperienceId]);

  const handleStateChange = useCallback(
    (state: { data: Record<string, unknown> }) => {
      latestData.current = state.data;
      pendingState.current = state.data;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushState, 800);
    },
    [flushState]
  );

  const handleRefine = useCallback(
    async (instruction: string) => {
      setEditBusy(true);
      setEditProgress(null);
      try {
        const result = await integratedExperienceService.refineExperience(
          initialExperienceId,
          instruction,
          currentContract,
          (receivedChars, attempt) =>
            setEditProgress(
              `${attempt > 1 ? `repair ${attempt - 1}, ` : ''}${(receivedChars / 1000).toFixed(1)}k`
            )
        );
        setEditWarnings(result.warnings);
        setCurrentContract(result.contract.toObject() as unknown as ContractType);
      } finally {
        setEditBusy(false);
        setEditProgress(null);
      }
    },
    [initialExperienceId, currentContract]
  );

  React.useEffect(() => {
    window.addEventListener("blur", flushState);
    window.addEventListener("beforeunload", flushState);
    return () => {
      window.removeEventListener("blur", flushState);
      window.removeEventListener("beforeunload", flushState);
      flushState();
    };
  }, [flushState]);

  // The webview shows no native alert, so bookmark feedback lives inline.
  const [bookmarkNote, setBookmarkNote] = useState<string | null>(null);
  const handleBookmark = useCallback(async () => {
    try {
      await persistenceService.bookmarkExperience({
        id: initialExperienceId,
        contract: currentContract,
        reactComponent: () => null,
        state: { data: {}, loading: {}, errors: {}, lastUpdated: new Date() },
        operations: new Map()
      });
      setBookmarkNote('Bookmarked');
    } catch (e) {
      setBookmarkNote(`Bookmark failed: ${(e as Error).message}`);
    }
    setTimeout(() => setBookmarkNote(null), 3000);
  }, [initialExperienceId, currentContract]);

  // Cross-window subscription to updates via Tauri events
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<{ experienceId: string; contract: ContractType }>(
        'experience-contract-updated',
        (event) => {
          if (event.payload?.experienceId === initialExperienceId && event.payload.contract) {
            setCurrentContract(event.payload.contract);
          }
        }
      );
    })();
    return () => { if (unlisten) unlisten(); };
  }, [initialExperienceId]);

  // Assembly lifecycle: the window opens while the model is still writing the
  // app; generation reports when it finishes or fails.
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<{ experienceId: string; status: string }>(
        'experience-assembly-status',
        (event) => {
          if (event.payload?.experienceId !== initialExperienceId) return;
          setAssembling(false);
          setAssemblyFailed(event.payload.status === 'failed');
        }
      );
    })();
    return () => { if (unlisten) unlisten(); };
  }, [initialExperienceId]);

  // A crashed render recovers when the next contract lands: the boundary is
  // keyed by a revision that advances with every contract change.
  const revisionRef = React.useRef(0);
  const contractRevision = useMemo(() => {
    revisionRef.current += 1;
    return revisionRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentContract]);

  // The window chrome follows the app's theme so the whole window reads as
  // one surface.
  const styling = (currentContract?.styling ?? {}) as { theme?: string; accent?: string };
  const themeClass = `der-theme-${
    styling.theme && (STYLE_THEMES as readonly string[]).includes(styling.theme)
      ? styling.theme
      : 'default'
  }`;
  const accentClass =
    styling.accent && (STYLE_ACCENTS as readonly string[]).includes(styling.accent)
      ? ` der-accent-${styling.accent}`
      : '';

  return (
    <div
      className={`der-window ${themeClass}${accentClass}`}
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <header className="der-window-header">
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {assembling && <span className="der-assembling">Assembling</span>}
          {assemblyFailed && (
            <span className="der-assembly-failed">
              Generation did not finish; this is a partial draft
            </span>
          )}
          {bookmarkNote && <span style={{ fontSize: "0.82rem", opacity: 0.75 }}>{bookmarkNote}</span>}
          <button onClick={handleBookmark} disabled={assembling}>Bookmark</button>
        </div>
      </header>
      <ExperienceEditBar
        onSubmit={handleRefine}
        busy={editBusy}
        progressNote={editProgress}
        warnings={editWarnings}
        onDismissWarnings={() => setEditWarnings([])}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ErrorBoundary
          key={contractRevision}
          fallback={
            <div style={{ padding: 16, opacity: 0.75 }}>
              The app view hit an error. It retries with the next update; close and reopen the
              window if this persists.
            </div>
          }
        >
          <LiveExperienceRenderer
            initialContract={currentContract}
            experienceId={initialExperienceId}
            initialData={rehydrationData}
            onStateChange={handleStateChange}
            enableRealTimeUpdates={true}
            onContractUpdate={(c) => setCurrentContract(c as unknown as ContractType)}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
};

export default App;
