/**
 * LLM Client - thin wrapper over the Tauri `llm_chat` command.
 *
 * Provider, model, and credentials are resolved on the Rust side from the
 * stored settings; the webview never holds secrets. Constructor config only
 * overrides the stored settings for this client instance.
 */

import { Channel, invoke } from '@tauri-apps/api/core';

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

export interface LLMSystemBlock {
  text: string;
  /**
   * Marks a prompt-cache breakpoint on Anthropic-shaped providers; everything
   * up to and including this block is cached across calls. Other providers
   * receive the blocks as one plain system message.
   */
  cache?: boolean;
}

export interface LLMSendOptions {
  /** Ask the provider for a JSON-only response where supported. */
  jsonMode?: boolean;
  maxTokens?: number;
  /** Structured system prompt sent ahead of any inline system messages. */
  systemBlocks?: LLMSystemBlock[];
  /**
   * Receives text deltas as the model produces them, on providers that
   * stream; the resolved response still carries the full content.
   */
  onChunk?: (delta: string) => void;
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
    // The command always takes a channel; the stream flag decides whether the
    // provider actually feeds it. Resolved defensively: test doubles of the
    // Tauri module may not define a Channel export at all.
    let onChunk: Channel<string> | undefined;
    let ChannelCtor: typeof Channel | undefined;
    try {
      ChannelCtor = typeof Channel === 'function' ? Channel : undefined;
    } catch {
      ChannelCtor = undefined;
    }
    if (ChannelCtor) {
      onChunk = new ChannelCtor<string>();
      const handler = options.onChunk;
      if (handler) {
        onChunk.onmessage = (delta) => handler(delta);
      }
    }

    return await invoke<LLMResponse>('llm_chat', {
      request: {
        messages,
        systemBlocks: options.systemBlocks,
        stream: Boolean(options.onChunk),
        provider: this.config.provider,
        model: this.config.model,
        maxTokens: options.maxTokens ?? this.config.maxTokens,
        temperature: this.config.temperature,
        jsonMode: options.jsonMode ?? false,
        baseUrl: this.config.baseUrl,
      },
      onChunk,
    });
  }
}
