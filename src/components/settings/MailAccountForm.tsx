/**
 * The one mail-account form for the webview face: opened from Settings and
 * from an app's "Set up email" affordance. Saves through the redacted
 * smtp commands; an empty password keeps the stored one.
 */

import React, { useEffect, useState } from 'react';
import './SettingsView.css';
import { SmtpView, getSmtpSettings, saveSmtpSettings } from '../../services/settings/smtp';

interface MailAccountFormProps {
  onSaved: (view: SmtpView) => void;
  onCancel: () => void;
}

export const MailAccountForm: React.FC<MailAccountFormProps> = ({ onSaved, onCancel }) => {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [security, setSecurity] = useState('starttls');
  const [from, setFrom] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSmtpSettings()
      .then((view) => {
        setHost(view.host);
        setPort(view.port === null ? '' : String(view.port));
        setUsername(view.username);
        setSecurity(view.security);
        setFrom(view.from);
        setHasPassword(view.hasPassword);
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const parsedPort = port.trim() ? Number.parseInt(port.trim(), 10) : null;
      const view = await saveSmtpSettings({
        host: host.trim(),
        port: Number.isNaN(parsedPort ?? 0) ? null : parsedPort,
        username: username.trim(),
        password,
        security,
        from: from.trim(),
      });
      onSaved(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mail-account-form">
      <p className="settings-hint">
        The password stays on this machine and mail only goes through this server.
      </p>
      {error && <p className="settings-error">{error}</p>}
      <div className="settings-integration-form">
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.example.net"
          disabled={busy}
        />
        <input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="port (optional)"
          disabled={busy}
        />
        <select value={security} onChange={(e) => setSecurity(e.target.value)} disabled={busy}>
          <option value="starttls">STARTTLS (587)</option>
          <option value="tls">TLS (465)</option>
        </select>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          disabled={busy}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={hasPassword ? 'password (saved; type to replace)' : 'password'}
          disabled={busy}
        />
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="from (Me <me@example.net>)"
          disabled={busy}
        />
        <div className="mail-account-actions">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button onClick={save} disabled={busy || !host.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default MailAccountForm;
