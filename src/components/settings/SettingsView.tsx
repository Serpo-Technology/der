/**
 * Settings view - LLM provider selection, credentials, and Claude sign-in.
 */

import React, { useCallback, useEffect, useState } from 'react';
import './SettingsView.css';
import {
  LlmSettingsView,
  MODEL_SUGGESTIONS,
  PROVIDER_LABELS,
  clearLlmCredential,
  finishClaudeSignIn,
  getLlmSettings,
  setLlmCredential,
  setLlmSettings,
  startClaudeSignIn,
  testLlmConnection,
  usesApiKey,
} from '../../services/settings/llm-settings';

interface SettingsViewProps {
  onError: (message: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onError }) => {
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [credentialInput, setCredentialInput] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [signInCode, setSignInCode] = useState('');
  const [signInPending, setSignInPending] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const applyView = useCallback((next: LlmSettingsView) => {
    setView(next);
    setProvider(next.settings.provider);
    setModel(next.settings.model || '');
    setBaseUrl(next.settings.baseUrl || '');
  }, []);

  useEffect(() => {
    (async () => {
      try {
        applyView(await getLlmSettings());
      } catch (error) {
        onError(
          `Could not load settings: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }, [applyView, onError]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setStatus('');
      try {
        await action();
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [onError]
  );

  const handleSaveSettings = useCallback(() => {
    run(async () => {
      const next = await setLlmSettings({
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim() || undefined,
      });
      applyView(next);
      setStatus('Settings saved.');
    });
  }, [run, provider, model, baseUrl, applyView]);

  const handleSaveCredential = useCallback(() => {
    run(async () => {
      const next = await setLlmCredential(provider, credentialInput);
      applyView(next);
      setCredentialInput('');
      setStatus('Key saved.');
    });
  }, [run, provider, credentialInput, applyView]);

  const handleClearCredential = useCallback(
    (target: string) => {
      run(async () => {
        const next = await clearLlmCredential(target);
        applyView(next);
        setStatus('Removed.');
      });
    },
    [run, applyView]
  );

  const handleStartSignIn = useCallback(() => {
    run(async () => {
      const url = await startClaudeSignIn();
      setAuthorizeUrl(url);
      setSignInPending(true);
      setStatus('Browser opened. Approve access, then paste the code below.');
    });
  }, [run]);

  const handleFinishSignIn = useCallback(() => {
    run(async () => {
      const next = await finishClaudeSignIn(signInCode);
      applyView(next);
      setSignInPending(false);
      setSignInCode('');
      setAuthorizeUrl('');
      setStatus('Signed in with Claude.');
    });
  }, [run, signInCode, applyView]);

  const handleSaveManualToken = useCallback(() => {
    run(async () => {
      const next = await setLlmCredential('claude-subscription', manualToken);
      applyView(next);
      setManualToken('');
      setStatus('Token saved.');
    });
  }, [run, manualToken, applyView]);

  const handleTest = useCallback(() => {
    run(async () => {
      setStatus('Testing...');
      setStatus(await testLlmConnection());
    });
  }, [run]);

  if (!view) {
    return <div className="settings-view">Loading settings...</div>;
  }

  const suggestions = MODEL_SUGGESTIONS[provider] || [];
  const savedKeyPreview = view.apiKeys[provider];
  const oauth = view.claudeOauth;

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Model provider</h3>
        <label className="settings-field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
            {view.providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p] || p}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>Model</span>
          <input
            list="model-suggestions"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={suggestions[0] || 'model id'}
            disabled={busy}
          />
          <datalist id="model-suggestions">
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        {provider === 'local' && (
          <label className="settings-field">
            <span>Base URL (required)</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              disabled={busy}
            />
          </label>
        )}
        <div className="settings-actions">
          <button className="primary" onClick={handleSaveSettings} disabled={busy}>
            Save settings
          </button>
          <button onClick={handleTest} disabled={busy}>
            Test connection
          </button>
        </div>
      </section>

      {usesApiKey(provider) ? (
        <section className="settings-section">
          <h3>API key</h3>
          {savedKeyPreview ? (
            <p className="settings-hint">
              Saved key: <code>{savedKeyPreview}</code>
              <button
                className="link-button"
                onClick={() => handleClearCredential(provider)}
                disabled={busy}
              >
                Remove
              </button>
            </p>
          ) : (
            <p className="settings-hint">No key saved for this provider.</p>
          )}
          <div className="settings-inline">
            <input
              type="password"
              value={credentialInput}
              onChange={(e) => setCredentialInput(e.target.value)}
              placeholder="Paste API key"
              disabled={busy}
            />
            <button onClick={handleSaveCredential} disabled={busy || !credentialInput.trim()}>
              Save key
            </button>
          </div>
        </section>
      ) : (
        <section className="settings-section">
          <h3>Claude account</h3>
          {oauth ? (
            <p className="settings-hint">
              Signed in <code>{oauth.tokenPreview}</code>
              {oauth.expiresAt
                ? ` (renews ${new Date(oauth.expiresAt * 1000).toLocaleString()})`
                : ' (long-lived token)'}
              <button
                className="link-button"
                onClick={() => handleClearCredential('claude-subscription')}
                disabled={busy}
              >
                Sign out
              </button>
            </p>
          ) : (
            <p className="settings-hint">Not signed in.</p>
          )}
          <div className="settings-actions">
            <button className="primary" onClick={handleStartSignIn} disabled={busy}>
              Sign in with Claude
            </button>
          </div>
          {signInPending && (
            <div className="settings-signin">
              <p className="settings-hint">
                Approve access in the browser, then paste the code shown on the confirmation page.
                {authorizeUrl && (
                  <>
                    {' '}
                    If the browser did not open, visit: <code>{authorizeUrl}</code>
                  </>
                )}
              </p>
              <div className="settings-inline">
                <input
                  value={signInCode}
                  onChange={(e) => setSignInCode(e.target.value)}
                  placeholder="Paste code"
                  disabled={busy}
                />
                <button onClick={handleFinishSignIn} disabled={busy || !signInCode.trim()}>
                  Finish sign-in
                </button>
              </div>
            </div>
          )}
          <details className="settings-details">
            <summary>Use a token instead</summary>
            <p className="settings-hint">
              Run <code>claude setup-token</code> in a terminal and paste the token here.
            </p>
            <div className="settings-inline">
              <input
                type="password"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="Paste token"
                disabled={busy}
              />
              <button onClick={handleSaveManualToken} disabled={busy || !manualToken.trim()}>
                Save token
              </button>
            </div>
          </details>
        </section>
      )}

      {status && <p className="settings-status">{status}</p>}
    </div>
  );
};

export default SettingsView;
