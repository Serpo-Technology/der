/**
 * LLM settings service - wraps the Rust settings, credential, and Claude
 * sign-in commands. Secrets are write-only from the webview; reads return
 * redacted previews.
 */

import { invoke } from '@tauri-apps/api/core';

export interface LlmSettings {
  provider: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ClaudeOauthStatus {
  signedIn: boolean;
  hasRefreshToken: boolean;
  expiresAt?: number;
  tokenPreview: string;
}

export interface LlmSettingsView {
  settings: LlmSettings;
  providers: string[];
  apiKeys: Record<string, string>;
  claudeOauth?: ClaudeOauthStatus;
}

export const PROVIDER_LABELS: Record<string, string> = {
  'claude-subscription': 'Claude (subscription sign-in)',
  anthropic: 'Claude (API key)',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  local: 'Local / OpenAI-compatible',
};

export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  'claude-subscription': ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  gemini: ['gemini-2.0-flash'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  local: [],
};

/** Providers whose credential is a plain API key (everything except the subscription sign-in). */
export function usesApiKey(provider: string): boolean {
  return provider !== 'claude-subscription';
}

export async function getLlmSettings(): Promise<LlmSettingsView> {
  return await invoke<LlmSettingsView>('get_llm_settings');
}

export async function setLlmSettings(settings: LlmSettings): Promise<LlmSettingsView> {
  return await invoke<LlmSettingsView>('set_llm_settings', { settings });
}

export async function setLlmCredential(provider: string, secret: string): Promise<LlmSettingsView> {
  return await invoke<LlmSettingsView>('set_llm_credential', { provider, secret });
}

export async function clearLlmCredential(provider: string): Promise<LlmSettingsView> {
  return await invoke<LlmSettingsView>('clear_llm_credential', { provider });
}

/** Opens the browser sign-in; resolves with the authorize URL for display. */
export async function startClaudeSignIn(): Promise<string> {
  return await invoke<string>('claude_oauth_start');
}

export async function finishClaudeSignIn(code: string): Promise<LlmSettingsView> {
  return await invoke<LlmSettingsView>('claude_oauth_finish', { code });
}

/** Sends a tiny request through the configured provider and reports the result. */
export async function testLlmConnection(): Promise<string> {
  const response = await invoke<{ content: string; provider: string; model: string }>('llm_chat', {
    request: {
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxTokens: 32,
    },
  });
  return `${response.provider} / ${response.model} responded: ${response.content.slice(0, 80)}`;
}
