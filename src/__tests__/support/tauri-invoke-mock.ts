/**
 * Shared Tauri invoke mock for the integration, acceptance, and performance
 * suites.
 *
 * Each suite declares the module mock itself (vi.mock factories are hoisted,
 * so they cannot live here):
 *
 *   vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
 *
 * and then calls `installInvokeMock()` in beforeEach. The installed
 * implementation routes the `llm_chat` command through the shared llm-mocks
 * fixtures and answers every storage-backed command benignly. Bookmark
 * commands are backed by an in-memory store so save and load round trips
 * behave like real persistence.
 */

import { vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { routeLlmChat } from '../../test/llm-mocks';

export const invokeMock = vi.mocked(invoke);

export interface StoredBookmark {
  id: string;
  name: string;
  description?: string;
  contract: unknown;
  tags?: string[];
  createdAt: string;
  lastAccessedAt: string;
}

export interface InvokeMockHandle {
  /** In-memory bookmark store keyed by bookmark id. */
  bookmarks: Map<string, StoredBookmark>;
}

export interface InvokeMockOptions {
  /**
   * Per-suite command hook. Return a value (or throw) to answer the command;
   * return undefined to fall through to the defaults below.
   */
  onCommand?: (cmd: string, args: any) => unknown;
}

export function installInvokeMock(options: InvokeMockOptions = {}): InvokeMockHandle {
  const bookmarks = new Map<string, StoredBookmark>();
  let bookmarkSeq = 0;

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    if (options.onCommand) {
      const handled = options.onCommand(cmd, args);
      if (handled !== undefined) {
        return handled;
      }
    }

    switch (cmd) {
      case 'llm_chat':
        return routeLlmChat(args);

      // Repository index storage is unavailable in tests; the repository
      // service falls back to its in-memory index.
      case 'read_repository_index':
        throw new Error('no stored repository index in tests');

      case 'bookmark_experience': {
        // Mirrors the Rust command: the experience id is the bookmark id, so
        // re-bookmarking the same experience overwrites the record.
        const id = args?.experienceId ?? `bookmark-${++bookmarkSeq}`;
        const now = new Date().toISOString();
        bookmarks.set(id, {
          id,
          name: args?.name ?? 'Unnamed Experience',
          description: args?.description,
          contract: args?.contract ?? {},
          tags: args?.tags,
          createdAt: now,
          lastAccessedAt: now,
        });
        return id;
      }
      case 'list_bookmarked_experiences':
      case 'list_bookmarked_experiences_detailed':
        return Array.from(bookmarks.values()).map((b) => ({ ...b, thumbnail: null }));
      case 'load_bookmarked_experience': {
        // Mirrors the Rust command: full snake_case record, null when missing.
        const record = bookmarks.get(args?.experienceId);
        if (!record) {
          return null;
        }
        return {
          id: record.id,
          name: record.name,
          description: record.description ?? null,
          contract: record.contract,
          created_at: record.createdAt,
          last_accessed_at: record.lastAccessedAt,
          tags: record.tags ?? null,
          thumbnail: null,
        };
      }
      case 'delete_bookmarked_experience':
        bookmarks.delete(args?.experienceId);
        return {};

      case 'share_experience': {
        const now = new Date().toISOString();
        return {
          contract: args?.contract ?? { name: 'shared', elements: [], operations: [] },
          metadata: {
            title: args?.title ?? 'Shared Experience',
            description: args?.description,
            author: args?.author,
            created_at: now,
            shared_at: now,
            tags: args?.tags,
            category: args?.category,
          },
          version: '1.0.0',
          checksum: 'mock-checksum',
        };
      }

      case 'execute_operation':
        return { success: true, data: {} };

      default:
        return {};
    }
  });

  return { bookmarks };
}
