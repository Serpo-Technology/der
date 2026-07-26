/**
 * The webview's client to the runtime core's sessions: the same protocol
 * the native panel speaks, over invoke instead of stdio. All writes and
 * dispatches run through one FIFO queue so user-action order reaches the
 * core exactly as it happened, mirroring stdio's natural serialization.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedNode } from '../runtime-view/resolve-view';

/** A pluggable session backend: Tauri's invoke by default, the wasm kernel
 * in the eval harness and in browsers without a core process. */
export interface SessionTransport {
  open(
    contract: unknown,
    initialData: Record<string, unknown>,
    experienceId: string
  ): Promise<SessionOpened>;
  setElement(sessionId: string, elementId: string, value: unknown): Promise<ResolvedNode[]>;
  dispatch(sessionId: string, operationIds: string[], item: unknown): Promise<EventOutcome>;
  close(sessionId: string): Promise<void>;
}

let sessionTransport: SessionTransport | undefined;

export function setSessionTransport(transport: SessionTransport | undefined): void {
  sessionTransport = transport;
}

export function hasSessionTransport(): boolean {
  return sessionTransport !== undefined;
}

export interface SessionOpened {
  sessionId: string;
  tree: ResolvedNode[];
  state: Record<string, unknown>;
}

export interface EventOutcome {
  failed: string | null;
  error: string | null;
  tree: ResolvedNode[];
  state: Record<string, unknown>;
}

export class CoreSessionClient {
  private sessionId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** Serializes an operation behind everything already queued. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    // The queue itself never rejects; callers see their own errors.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async open(
    contract: unknown,
    initialData: Record<string, unknown>,
    experienceId: string
  ): Promise<SessionOpened> {
    return this.enqueue(async () => {
      if (this.sessionId) {
        const stale = this.sessionId;
        this.sessionId = null;
        if (sessionTransport) {
          await sessionTransport.close(stale).catch(() => undefined);
        } else {
          await invoke('runtime_close_session', { sessionId: stale }).catch(() => undefined);
        }
      }
      const opened = sessionTransport
        ? await sessionTransport.open(contract, initialData, experienceId)
        : await invoke<SessionOpened>('runtime_open_session', {
            contract,
            initialData,
            experienceId,
          });
      this.sessionId = opened.sessionId;
      return opened;
    });
  }

  /** Element write plus the fresh tree, matching the panel's echo. */
  async setElement(elementId: string, value: unknown): Promise<ResolvedNode[] | null> {
    return this.enqueue(async () => {
      if (!this.sessionId) return null;
      const sessionId = this.sessionId;
      if (sessionTransport) {
        return await sessionTransport.setElement(sessionId, elementId, value);
      }
      await invoke('runtime_set_element', { sessionId, elementId, value });
      return await invoke<ResolvedNode[]>('runtime_resolve_view', { sessionId });
    });
  }

  async dispatch(operationIds: string[], item: unknown): Promise<EventOutcome | null> {
    return this.enqueue(async () => {
      if (!this.sessionId) return null;
      if (sessionTransport) {
        return await sessionTransport.dispatch(this.sessionId, operationIds, item ?? null);
      }
      return await invoke<EventOutcome>('runtime_dispatch_event', {
        sessionId: this.sessionId,
        operationIds,
        item: item ?? null,
      });
    });
  }

  async close(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sessionId) return;
      const sessionId = this.sessionId;
      this.sessionId = null;
      if (sessionTransport) {
        await sessionTransport.close(sessionId).catch(() => undefined);
        return;
      }
      await invoke('runtime_close_session', { sessionId }).catch(() => undefined);
    });
  }
}
