/**
 * SMTP account settings: the mail server behind the email.send builtin.
 * The password is stored on the Rust side; the webview only ever sees the
 * redacted view (hasPassword), and an empty password on save keeps the
 * stored one.
 */

import { invoke } from '@tauri-apps/api/core';

export interface SmtpView {
  host: string;
  port: number | null;
  username: string;
  hasPassword: boolean;
  security: string;
  from: string;
}

export interface SmtpDraft {
  host: string;
  port: number | null;
  username: string;
  password: string;
  security: string;
  from: string;
}

export async function getSmtpSettings(): Promise<SmtpView> {
  return await invoke<SmtpView>('smtp_get');
}

export async function saveSmtpSettings(config: SmtpDraft): Promise<SmtpView> {
  return await invoke<SmtpView>('smtp_save', { config });
}
