/**
 * The webview face's route to the runtime core's commands. Under the
 * desktop app this is Tauri's invoke; a window with no core process
 * behind it installs a router served by the in-process kernel instead
 * (see browser-core.ts). Faces call commands either way; only the host
 * answering them changes.
 */

import { invoke } from '@tauri-apps/api/core';

export type CoreCommandRouter = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

let router: CoreCommandRouter | null = null;

export function setCoreCommandRouter(next: CoreCommandRouter | null): void {
  router = next;
}

export function coreInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (router) {
    return router(command, args) as Promise<T>;
  }
  return invoke<T>(command, args);
}
