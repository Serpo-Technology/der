/**
 * The webview's client to the runtime core's sessions: the same protocol
 * the native panel speaks, over invoke instead of stdio. All writes and
 * dispatches run through one FIFO queue so user-action order reaches the
 * core exactly as it happened, mirroring stdio's natural serialization.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedNode } from '../runtime-view/resolve-view';

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
        await invoke('runtime_close_session', { sessionId: stale }).catch(() => undefined);
      }
      const opened = await invoke<SessionOpened>('runtime_open_session', {
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
      await invoke('runtime_set_element', { sessionId, elementId, value });
      return await invoke<ResolvedNode[]>('runtime_resolve_view', { sessionId });
    });
  }

  async dispatch(operationIds: string[], item: unknown): Promise<EventOutcome | null> {
    return this.enqueue(async () => {
      if (!this.sessionId) return null;
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
      await invoke('runtime_close_session', { sessionId }).catch(() => undefined);
    });
  }
}

/** True when a contract still leans on the webview-only local escape hatch;
 * such contracts keep the local renderer. */
export function contractUsesLocalCode(contract: {
  operations?: Array<{ executionType?: string; implementation?: { code?: string } }>;
}): boolean {
  return (contract.operations ?? []).some(
    (operation) => operation.executionType === 'local' || Boolean(operation.implementation?.code)
  );
}
