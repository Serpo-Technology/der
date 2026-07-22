/**
 * Parts view: the installed signed operation parts, with install and remove.
 * Installing shows the publisher fingerprint before anything is written, so
 * what you confirm is exactly what gets pinned.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fragmentsService,
  InstalledFragment,
  StageSummary,
} from '../../services/fragments/FragmentsService';
import './PartsView.css';

interface PartsViewProps {
  onError?: (message: string) => void;
}

export const PartsView: React.FC<PartsViewProps> = ({ onError }) => {
  const [installed, setInstalled] = useState<InstalledFragment[]>([]);
  const [staged, setStaged] = useState<StageSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [forceDowngrade, setForceDowngrade] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

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
            <span>Key fingerprint</span>
            <code>{staged.fingerprintGrouped}</code>
            <span>Operations</span>
            <div>
              {staged.operations.map((op) => (
                <div key={op.name}>
                  <code>{op.name}</code> {op.description}
                </div>
              ))}
            </div>
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
          {installed.map((part) => (
            <div key={part.manifest.id} className="parts-card">
              <div className="parts-card-header">
                <div>
                  <strong>{part.manifest.name}</strong>
                  <span className="parts-version">v{part.manifest.version}</span>
                </div>
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
              <p>{part.manifest.description}</p>
              <div className="parts-meta">
                <span>Publisher: {part.manifest.publisher}</span>
                <code>{part.fingerprintGrouped}</code>
              </div>
              <div className="parts-ops">
                {part.manifest.operations.map((op) => (
                  <div key={op.name}>
                    <code>{op.name}</code> {op.description}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function describeInvokeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'The part operation failed';
}

export default PartsView;
