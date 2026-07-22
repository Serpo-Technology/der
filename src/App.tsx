import "./App.css";
import { MainInterface } from "./components/MainInterface.tsx";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LiveExperienceRenderer } from "./components/runtime/LiveExperienceRenderer";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { Contract as ContractType } from "./types/contract";
import { integratedExperienceService } from "./services/IntegratedExperienceService";
import { persistenceService } from "./services/persistence";
import { repositoryService } from "./services/repository/repository-service";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { registerBuiltins } from "./services/repository/builtins";

function App() {
  // Seed the shared component catalog once at startup.
  useEffect(() => {
    registerBuiltins(repositoryService).catch((error) =>
      console.warn("Failed to register built-in components", error)
    );
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injected = (globalThis as any).__DER_BOOTSTRAP as
    | { experienceId?: string; contract?: ContractType | string; state?: Record<string, unknown> | null }
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
}> = ({ initialExperienceId, initialContract, savedState }) => {
  const [currentContract, setCurrentContract] = useState<ContractType>(initialContract);
  const title = useMemo(() => currentContract.name || initialExperienceId, [currentContract.name, initialExperienceId]);

  // Persist the app's state so it survives closing the window. Writes are
  // debounced; the latest snapshot is flushed when the window goes away.
  const pendingState = React.useRef<Record<string, unknown> | null>(null);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
      pendingState.current = state.data;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushState, 800);
    },
    [flushState]
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

  const handleEdit = useCallback(async () => {
    const input = globalThis.prompt("Describe your edits for the AI to apply:");
    if (!input) return;
    try {
      const result = await integratedExperienceService.regenerateExperienceWithPreservation(
        initialExperienceId,
        input,
        { enableRealTimeUpdates: true, autoSave: true }
      );
      setCurrentContract(result.updatedContract as unknown as ContractType);
    } catch (e) {
      alert(`Edit failed: ${(e as Error).message}`);
    }
  }, [initialExperienceId]);

  const handleBookmark = useCallback(async () => {
    try {
      await persistenceService.bookmarkExperience({
        id: initialExperienceId,
        contract: currentContract,
        reactComponent: () => null,
        state: { data: {}, loading: {}, errors: {}, lastUpdated: new Date() },
        operations: new Map()
      });
      alert("Bookmarked");
    } catch (e) {
      alert(`Bookmark failed: ${(e as Error).message}`);
    }
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #eee" }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleEdit}>Edit</button>
          <button onClick={handleBookmark}>Bookmark</button>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <LiveExperienceRenderer
          initialContract={currentContract}
          experienceId={initialExperienceId}
          initialData={savedState}
          onStateChange={handleStateChange}
          enableRealTimeUpdates={true}
          onContractUpdate={(c) => setCurrentContract(c as unknown as ContractType)}
        />
      </div>
    </div>
  );
};

export default App;
