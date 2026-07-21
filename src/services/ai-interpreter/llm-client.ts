/**
 * LLM Client - thin wrapper over the Tauri `llm_chat` command.
 *
 * Provider, model, and credentials are resolved on the Rust side from the
 * stored settings; the webview never holds secrets. Constructor config only
 * overrides the stored settings for this client instance.
 */

import { invoke } from '@tauri-apps/api/core';

export type LLMProvider =
  | 'claude-subscription'
  | 'anthropic'
  | 'deepseek'
  | 'gemini'
  | 'openai'
  | 'local';

export interface LLMConfig {
  provider?: LLMProvider;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMSendOptions {
  /** Ask the provider for a JSON-only response where supported. */
  jsonMode?: boolean;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  provider?: string;
  model?: string;
}

export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig = {}) {
    this.config = config;
  }

  async sendMessage(messages: LLMMessage[], options: LLMSendOptions = {}): Promise<LLMResponse> {
    return await invoke<LLMResponse>('llm_chat', {
      request: {
        messages,
        provider: this.config.provider,
        model: this.config.model,
        maxTokens: options.maxTokens ?? this.config.maxTokens,
        temperature: this.config.temperature,
        jsonMode: options.jsonMode ?? false,
        baseUrl: this.config.baseUrl,
      },
    });
  }
}
