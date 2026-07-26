/**
 * Parts view: the installed signed operation parts, with install and remove.
 * Installing shows the publisher fingerprint before anything is written, so
 * what you confirm is exactly what gets pinned.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fragmentsService,
  InstalledFragment,
  PartCredentialRequirement,
  RegistryPartEntry,
  StageSummary,
} from '../../services/fragments/FragmentsService';
import { getRecipeDef } from '../../services/operations/registry';
import { RecipeCheck, checkRecipe } from '../../services/recipes/RecipeService';
import { integratedExperienceService } from '../../services/IntegratedExperienceService';
import './PartsView.css';

interface PartsViewProps {
  onError?: (message: string) => void;
}

export const PartsView: React.FC<PartsViewProps> = ({ onError }) => {
  const [installed, setInstalled] = useState<InstalledFragment[]>([]);
  const [staged, setStaged] = useState<StageSummary | null>(null);
  const [registryUrl, setRegistryUrl] = useState(
    () => localStorage.getItem('der-registry-url') ?? ''
  );
  const [registryParts, setRegistryParts] = useState<RegistryPartEntry[] | null>(null);
  const [partSecrets, setPartSecrets] = useState<Record<string, string[]>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const entries: Record<string, string[]> = {};
      for (const part of installed) {
        if (part.manifest.service?.credentials?.length) {
          try {
            entries[part.manifest.id] = await fragmentsService.listPartCredentials(
              part.manifest.id
            );
          } catch {
            entries[part.manifest.id] = [];
          }
        }
      }
      setPartSecrets(entries);
    })();
  }, [installed]);

  const handleSaveSecret = useCallback(
    async (fragmentId: string, requirement: PartCredentialRequirement) => {
      const draftKey = `${fragmentId}:${requirement.name}`;
      const secret = secretDrafts[draftKey]?.trim();
      if (!secret) return;
      setBusy(true);
      try {
        const names = await fragmentsService.setPartCredential(
          fragmentId,
          requirement.name,
          secret
        );
        setPartSecrets((prev) => ({ ...prev, [fragmentId]: names }));
        setSecretDrafts((prev) => ({ ...prev, [draftKey]: '' }));
      } catch (error) {
        onError?.(error instanceof Error ? error.message : describeInvokeError(error));
      } finally {
        setBusy(false);
      }
    },
    [secretDrafts, onError]
  );

  const handleFetchRegistry = useCallback(async () => {
    const url = registryUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      const index = await fragmentsService.fetchRegistryIndex(url);
      setRegistryParts(index.parts);
      localStorage.setItem('der-registry-url', url);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : describeInvokeError(error));
    } finally {
      setBusy(false);
    }
  }, [registryUrl, onError]);

  // A saved registry is checked quietly when the view opens, so newer part
  // versions show up without anyone remembering to fetch. Failures stay
  // silent here; the manual Fetch button reports them.
  useEffect(() => {
    const url = localStorage.getItem('der-registry-url')?.trim();
    if (!url) return;
    fragmentsService
      .fetchRegistryIndex(url)
      .then((index) => setRegistryParts(index.parts))
      .catch(() => {});
  }, []);

  const handleInstallFromRegistry = useCallback(
    async (entry: RegistryPartEntry) => {
      setBusy(true);
      setForceDowngrade(false);
      try {
        setStaged(await fragmentsService.stageFromRegistry(entry.bundleUrl));
      } catch (error) {
        onError?.(error instanceof Error ? error.message : describeInvokeError(error));
      } finally {
        setBusy(false);
      }
    },
    [onError]
  );
  const [busy, setBusy] = useState(false);
  const [forceDowngrade, setForceDowngrade] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Each installed recipe is validated against the current part vocabulary;
  // one whose parts are missing shows as unavailable instead of opening
  // broken.
  const [recipeChecks, set_recipeChecks] = useState<Record<string, RecipeCheck>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const checks: Record<string, RecipeCheck> = {};
      for (const part of installed) {
        for (const recipe of part.manifest.recipes ?? []) {
          const def = getRecipeDef(recipe.name);
          if (def) checks[recipe.name] = await checkRecipe(def);
        }
      }
      if (!cancelled) set_recipeChecks(checks);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [installed]);

  const handleOpenRecipe = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        await integratedExperienceService.createExperienceFromRecipe(name, {
          preserveEdits: true,
          autoSave: true,
          enableRealTimeUpdates: true,
        });
      } catch (error) {
        onError?.(error instanceof Error ? error.message : describeInvokeError(error));
      } finally {
        setBusy(false);
      }
    },
    [onError]
  );

  const refresh = useCallback(async () => {
    await fragmentsService.init();
    setInstalled(fragmentsService.getInstalled());
  }, []);

  useEffect(() => {
    refresh().catch(() => setInstalled([]));
  }, [refresh]);

  const handlePickFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setForceDowngrade(false);
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of buffer) {
        binary += String.fromCharCode(byte);
      }
      const summary = await fragmentsService.stage(btoa(binary));
      setStaged(summary);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : describeInvokeError(error));
    } finally {
      setBusy(false);
    }
  }, [onError]);

  const handleCommit = useCallback(async () => {
    if (!staged) return;
    setBusy(true);
    try {
      await fragmentsService.commit(staged.stagingToken, staged.fingerprint, forceDowngrade);
      setStaged(null);
      setForceDowngrade(false);
      await refresh();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : describeInvokeError(error));
    } finally {
      setBusy(false);
    }
  }, [staged, forceDowngrade, refresh, onError]);

  // The webview has no native confirm dialog: the first click arms removal,
  // the second performs it, and the armed state falls back after a moment.
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmingRemove) return;
    const timer = setTimeout(() => setConfirmingRemove(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmingRemove]);

  const handleRemove = useCallback(
    async (id: string) => {
      if (confirmingRemove !== id) {
        setConfirmingRemove(id);
        return;
      }
      setConfirmingRemove(null);
      setBusy(true);
      try {
        await fragmentsService.remove(id);
        await refresh();
      } catch (error) {
        onError?.(error instanceof Error ? error.message : describeInvokeError(error));
      } finally {
        setBusy(false);
      }
    },
    [confirmingRemove, refresh, onError]
  );

  return (
    <div className="parts-view">
      <div className="parts-header">
        <div>
          <h2>Parts</h2>
          <p>Signed operation parts extend what your apps can compute. Each runs sandboxed.</p>
        </div>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".derpart"
            style={{ display: 'none' }}
            onChange={handlePickFile}
          />
          <button
            className="primary"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            Install part
          </button>
        </div>
      </div>

      <div className="parts-registry">
        <h3>Browse a registry</h3>
        <div className="parts-registry-bar">
          <input
            value={registryUrl}
            onChange={(e) => setRegistryUrl(e.target.value)}
            placeholder="https://example.com/parts/index.json"
            disabled={busy}
            aria-label="Registry index URL"
          />
          <button onClick={handleFetchRegistry} disabled={busy || !registryUrl.trim()}>
            Fetch
          </button>
        </div>
        {registryParts && registryParts.length === 0 && (
          <p className="parts-registry-note">The registry lists no parts.</p>
        )}
        {registryParts && registryParts.length > 0 && (
          <div className="parts-list">
            {registryParts.map((entry) => {
              const installedPart = installed.find((p) => p.manifest.id === entry.id);
              const hasUpdate =
                !!installedPart && versionNewer(entry.version, installedPart.manifest.version);
              return (
                <div key={entry.id} className="parts-card">
                  <div className="parts-card-header">
                    <div>
                      <strong>{entry.name}</strong>
                      <span className="parts-version">v{entry.version}</span>
                    </div>
                    <button
                      onClick={() => handleInstallFromRegistry(entry)}
                      disabled={busy || (!!installedPart && !hasUpdate)}
                      title={
                        installedPart && !hasUpdate
                          ? 'Already installed'
                          : 'Download and review before installing'
                      }
                    >
                      {installedPart
                        ? hasUpdate
                          ? `Update to ${entry.version}`
                          : 'Installed'
                        : 'Install'}
                    </button>
                  </div>
                  <p>{entry.description}</p>
                  <div className="parts-meta">
                    <span>Publisher: {entry.publisher}</span>
                    <span>{[...entry.operations, ...(entry.recipes ?? [])].join(', ')}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {staged && (
        <div className="parts-stage-card">
          <h3>Review before installing</h3>
          <div className="parts-stage-grid">
            <span>Name</span>
            <strong>
              {staged.name} {staged.version}
            </strong>
            <span>Publisher</span>
            <strong>{staged.publisher}</strong>
            {(staged.capabilities ?? []).length > 0 && (
              <>
                <span>Access</span>
                <strong>{staged.capabilities.join(', ')}</strong>
              </>
            )}
            <span>Key fingerprint</span>
            <code>{staged.fingerprintGrouped}</code>
            {staged.operations.length > 0 && (
              <>
                <span>Operations</span>
                <div>
                  {staged.operations.map((op) => (
                    <div key={op.name}>
                      <code>{op.name}</code> {op.description}
                    </div>
                  ))}
                </div>
              </>
            )}
            {(staged.recipes ?? []).length > 0 && (
              <>
                <span>Apps</span>
                <div>
                  {staged.recipes.map((recipe) => (
                    <div key={recipe.name}>
                      <strong>{recipe.title}</strong> {recipe.description}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {staged.publisherStatus === 'new' && (
            <p className="parts-note">
              First install from this publisher. The key above will be trusted for future
              updates; compare it with the fingerprint the publisher shares.
            </p>
          )}
          {staged.publisherStatus === 'known' && (
            <p className="parts-note">Publisher key matches the one already trusted.</p>
          )}
          {staged.publisherStatus === 'keyMismatch' && (
            <p className="parts-block">
              This bundle is signed with a DIFFERENT key than the one trusted for
              "{staged.publisher}". Installation is blocked.
            </p>
          )}
          {staged.isDowngrade && (
            <label className="parts-note">
              <input
                type="checkbox"
                checked={forceDowngrade}
                onChange={(e) => setForceDowngrade(e.target.checked)}
              />
              This is an older version than the one installed; install it anyway.
            </label>
          )}
          <div className="parts-stage-actions">
            <button
              className="primary"
              onClick={handleCommit}
              disabled={
                busy ||
                staged.publisherStatus === 'keyMismatch' ||
                (staged.isDowngrade && !forceDowngrade)
              }
            >
              Install
            </button>
            <button onClick={() => setStaged(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {installed.length === 0 && !staged ? (
        <div className="parts-empty">
          No parts installed yet. Install a .derpart file and its operations become available
          to every app you create.
        </div>
      ) : (
        <div className="parts-list">
          {installed.map((part) => {
            const registryEntry = registryParts?.find((e) => e.id === part.manifest.id);
            const update =
              registryEntry && versionNewer(registryEntry.version, part.manifest.version)
                ? registryEntry
                : null;
            return (
            <div key={part.manifest.id} className="parts-card">
              <div className="parts-card-header">
                <div>
                  <strong>{part.manifest.name}</strong>
                  <span className="parts-version">v{part.manifest.version}</span>
                  {update && <span className="parts-update">update available</span>}
                </div>
                <div className="parts-card-actions">
                  {update && (
                    <button
                      onClick={() => handleInstallFromRegistry(update)}
                      disabled={busy}
                      title="Download and review before installing"
                    >
                      Update to {update.version}
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => handleRemove(part.manifest.id)}
                    disabled={busy}
                    title={
                      confirmingRemove === part.manifest.id
                        ? 'Click again to remove'
                        : 'Apps composed with this part will stop working'
                    }
                  >
                    {confirmingRemove === part.manifest.id ? 'Click again to remove' : 'Remove'}
                  </button>
                </div>
              </div>
              <p>{part.manifest.description}</p>
              <div className="parts-meta">
                <span>Publisher: {part.manifest.publisher}</span>
                <code>{part.fingerprintGrouped}</code>
              </div>
              {part.manifest.service && (
                <div className="parts-service">
                  <span>Calls {part.manifest.service.baseUrl}</span>
                  {(part.manifest.service.credentials ?? []).map((requirement) => {
                    const saved = partSecrets[part.manifest.id]?.includes(requirement.name);
                    const draftKey = `${part.manifest.id}:${requirement.name}`;
                    return (
                      <div key={requirement.name} className="parts-credential">
                        <span>
                          {requirement.label}
                          {saved ? ' (saved)' : ''}
                        </span>
                        <input
                          type="password"
                          value={secretDrafts[draftKey] ?? ''}
                          onChange={(e) =>
                            setSecretDrafts((prev) => ({
                              ...prev,
                              [draftKey]: e.target.value
                            }))
                          }
                          placeholder={saved ? 'replace' : 'enter secret'}
                          disabled={busy}
                        />
                        <button
                          onClick={() => handleSaveSecret(part.manifest.id, requirement)}
                          disabled={busy || !(secretDrafts[draftKey] ?? '').trim()}
                        >
                          Save
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="parts-ops">
                {part.manifest.operations.map((op) => (
                  <div key={op.name}>
                    <code>{op.name}</code> {op.description}
                  </div>
                ))}
              </div>
              {(part.manifest.recipes ?? []).length > 0 && (
                <div className="parts-recipes">
                  {(part.manifest.recipes ?? []).map((recipe) => {
                    const check = recipeChecks[recipe.name];
                    const blocked = !!check && !check.ok;
                    return (
                      <div key={recipe.name} className="parts-recipe">
                        <div className="parts-recipe-text">
                          <strong>{recipe.title}</strong>
                          <span>{recipe.description}</span>
                        </div>
                        <button
                          className="primary"
                          onClick={() => handleOpenRecipe(recipe.name)}
                          disabled={busy || blocked}
                          title={
                            blocked
                              ? check.problems.join('\n')
                              : 'Open this app in its own window'
                          }
                        >
                          {blocked ? 'Unavailable' : 'Open'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** True when version a is newer than b (dotted numeric segments). */
export function versionNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => parseInt(s, 10));
  const pb = b.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

function describeInvokeError(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'The part operation failed';
}

export default PartsView;
