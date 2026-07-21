import "./App.css";
import { MainInterface } from "./components/MainInterface.tsx";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LiveExperienceRenderer } from "./components/runtime/LiveExperienceRenderer";
import { listen } from "@tauri-apps/api/event";
import type { Contract as ContractType } from "./types/contract";
import { integratedExperienceService } from "./services/IntegratedExperienceService";
import { repositoryService } from "./services/repository/repository-service";
import { registerBuiltins } from "./services/repository/builtins";

function App() {
  // Seed the shared component catalog once at startup.
  useEffect(() => {
    registerBuiltins(repositoryService).catch((error) =>
      console.warn("Failed to register built-in components", error)
    );
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injected = (globalThis as any).__DER_BOOTSTRAP as { experienceId?: string; contract?: ContractType } | undefined;

  if (injected?.experienceId && injected?.contract) {
    return (
      <div className="app" style={{ width: "100%", height: "100%" }}>
        <ExperienceWindow initialExperienceId={injected.experienceId} initialContract={injected.contract} />
      </div>
    );
  }

  return (
    <div className="app">
      <MainInterface />
    </div>
  );
}

const ExperienceWindow: React.FC<{ initialExperienceId: string; initialContract: ContractType }> = ({ initialExperienceId, initialContract }) => {
  const [currentContract, setCurrentContract] = useState<ContractType>(initialContract);
  const title = useMemo(() => currentContract.name || initialExperienceId, [currentContract.name, initialExperienceId]);

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
      await integratedExperienceService.bookmarkExperience(initialExperienceId, "current-user", { tags: ["window"], collection: "Experiences" });
      alert("Bookmarked");
    } catch (e) {
      alert(`Bookmark failed: ${(e as Error).message}`);
    }
  }, [initialExperienceId]);

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
          <button onClick={handleEdit}>✏️ Edit</button>
          <button onClick={handleBookmark}>🔖 Bookmark</button>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <LiveExperienceRenderer
          initialContract={currentContract}
          experienceId={initialExperienceId}
          enableRealTimeUpdates={true}
          onContractUpdate={(c) => setCurrentContract(c as unknown as ContractType)}
        />
      </div>
    </div>
  );
};

export default App;
