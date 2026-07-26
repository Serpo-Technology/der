/**
 * Settings view - LLM provider selection, credentials, and Claude sign-in.
 */

import React, { useCallback, useEffect, useState } from 'react';
import './SettingsView.css';
import {
  IntegrationCredentialView,
  deleteIntegrationCredential,
  refreshIntegrationCredentials,
  setIntegrationCredential,
} from '../../services/settings/integrations';
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
import { getSmtpSettings, saveSmtpSettings } from '../../services/settings/smtp';

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
  const [integrations, setIntegrations] = useState<IntegrationCredentialView[]>([]);
  const [integrationName, setIntegrationName] = useState('');
  const [integrationKind, setIntegrationKind] = useState('bearer');
  const [integrationTarget, setIntegrationTarget] = useState('');
  const [integrationBaseUrl, setIntegrationBaseUrl] = useState('');
  const [integrationNotes, setIntegrationNotes] = useState('');
  const [integrationSecret, setIntegrationSecret] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpSecurity, setSmtpSecurity] = useState('starttls');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);

  useEffect(() => {
    refreshIntegrationCredentials().then(setIntegrations).catch(() => undefined);
    getSmtpSettings()
      .then((view) => {
        setSmtpHost(view.host);
        setSmtpPort(view.port === null ? '' : String(view.port));
        setSmtpUsername(view.username);
        setSmtpSecurity(view.security);
        setSmtpFrom(view.from);
        setSmtpHasPassword(view.hasPassword);
      })
      .catch(() => undefined);
  }, []);

  const handleSaveSmtp = useCallback(async () => {
    setBusy(true);
    try {
      const port = smtpPort.trim() ? Number.parseInt(smtpPort.trim(), 10) : null;
      const view = await saveSmtpSettings({
        host: smtpHost.trim(),
        port: Number.isNaN(port ?? 0) ? null : port,
        username: smtpUsername.trim(),
        password: smtpPassword,
        security: smtpSecurity,
        from: smtpFrom.trim(),
      });
      setSmtpHasPassword(view.hasPassword);
      setSmtpPassword('');
      setStatus('Email settings saved');
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [smtpHost, smtpPort, smtpUsername, smtpPassword, smtpSecurity, smtpFrom, onError]);

  const handleAddIntegration = useCallback(async () => {
    setBusy(true);
    try {
      const views = await setIntegrationCredential(
        integrationName.trim(),
        integrationKind,
        integrationKind === 'bearer' ? undefined : integrationTarget.trim(),
        integrationBaseUrl.trim(),
        integrationNotes.trim() || undefined,
        integrationSecret
      );
      setIntegrations(views);
      setIntegrationName('');
      setIntegrationTarget('');
      setIntegrationBaseUrl('');
      setIntegrationNotes('');
      setIntegrationSecret('');
      setStatus('Credential saved');
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    integrationName,
    integrationKind,
    integrationTarget,
    integrationBaseUrl,
    integrationNotes,
    integrationSecret,
    onError
  ]);

  const handleDeleteIntegration = useCallback(async (name: string) => {
    setBusy(true);
    try {
      setIntegrations(await deleteIntegrationCredential(name));
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [onError]);

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

      <section className="settings-section">
        <h3>Integrations</h3>
        <p className="settings-hint">
          Named credentials for apps that call external services. Apps reference a
          credential by name; the secret stays on this machine and never appears in
          an app definition.
        </p>
        {integrations.length > 0 && (
          <ul className="settings-integrations">
            {integrations.map((cred) => (
              <li key={cred.name}>
                <code>{cred.name}</code>
                <span>
                  {cred.kind === 'bearer'
                    ? 'bearer token'
                    : `${cred.kind} "${cred.target ?? ''}"`}
                  {cred.baseUrl ? ` at ${cred.baseUrl}` : ''}
                </span>
                <button
                  className="link-button"
                  onClick={() => handleDeleteIntegration(cred.name)}
                  disabled={busy}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-field">
          <span>Add a credential</span>
          <div className="settings-integration-form">
            <input
              value={integrationName}
              onChange={(e) => setIntegrationName(e.target.value)}
              placeholder="name (e.g. weather-api)"
              disabled={busy}
            />
            <select
              value={integrationKind}
              onChange={(e) => setIntegrationKind(e.target.value)}
              disabled={busy}
            >
              <option value="bearer">Bearer token</option>
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
            {integrationKind !== 'bearer' && (
              <input
                value={integrationTarget}
                onChange={(e) => setIntegrationTarget(e.target.value)}
                placeholder={integrationKind === 'header' ? 'header name' : 'parameter name'}
                disabled={busy}
              />
            )}
            <input
              value={integrationBaseUrl}
              onChange={(e) => setIntegrationBaseUrl(e.target.value)}
              placeholder="service base URL (secret is only sent there)"
              disabled={busy}
            />
            <input
              value={integrationNotes}
              onChange={(e) => setIntegrationNotes(e.target.value)}
              placeholder="notes for the AI: endpoint shape, response fields, units"
              disabled={busy}
            />
            <input
              type="password"
              value={integrationSecret}
              onChange={(e) => setIntegrationSecret(e.target.value)}
              placeholder="secret"
              disabled={busy}
            />
            <button
              onClick={handleAddIntegration}
              disabled={
                busy ||
                !integrationName.trim() ||
                !integrationSecret.trim() ||
                !integrationBaseUrl.trim()
              }
            >
              Save
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Email (SMTP)</h3>
        <p className="settings-hint">
          Apps that send email use this account. The password stays on this machine
          and mail only goes through this server.
        </p>
        <div className="settings-field">
          <span>Server</span>
          <div className="settings-integration-form">
            <input
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.example.net"
              disabled={busy}
            />
            <input
              value={smtpPort}
              onChange={(e) => setSmtpPort(e.target.value)}
              placeholder="port (optional)"
              disabled={busy}
            />
            <select
              value={smtpSecurity}
              onChange={(e) => setSmtpSecurity(e.target.value)}
              disabled={busy}
            >
              <option value="starttls">STARTTLS (587)</option>
              <option value="tls">TLS (465)</option>
            </select>
            <input
              value={smtpUsername}
              onChange={(e) => setSmtpUsername(e.target.value)}
              placeholder="username"
              disabled={busy}
            />
            <input
              type="password"
              value={smtpPassword}
              onChange={(e) => setSmtpPassword(e.target.value)}
              placeholder={smtpHasPassword ? 'password (saved; type to replace)' : 'password'}
              disabled={busy}
            />
            <input
              value={smtpFrom}
              onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="from (Me <me@example.net>)"
              disabled={busy}
            />
            <button onClick={handleSaveSmtp} disabled={busy || !smtpHost.trim()}>
              Save
            </button>
          </div>
        </div>
      </section>

      {status && <p className="settings-status">{status}</p>}
    </div>
  );
};

export default SettingsView;
