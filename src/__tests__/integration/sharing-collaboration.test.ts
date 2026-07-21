/**
 * Integration Tests: Sharing and Collaboration Functionality
 * Exercises SharingService, BookmarkManager, and PersistenceService against
 * mocked Tauri storage commands backed by an in-memory bookmark store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SharingService } from '../../services/persistence/SharingService';
import { BookmarkManager } from '../../services/persistence/BookmarkManager';
import { PersistenceService } from '../../services/persistence/PersistenceService';
import { installInvokeMock, invokeMock, InvokeMockHandle } from '../support/tauri-invoke-mock';
import type { ShareableContract } from '../../types/persistence';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn(async () => ({
      execute: vi.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 })),
      select: vi.fn(async () => []),
      close: vi.fn(async () => true),
    })),
  },
}));

const dashboardContract = {
  name: 'Shared Dashboard',
  version: '1.0.0',
  elements: [
    {
      id: 'title',
      type: 'text',
      properties: { content: 'Analytics Dashboard' },
      dataBindings: [],
      eventBindings: [],
    },
    {
      id: 'refresh-button',
      type: 'button',
      properties: { text: 'Refresh Data' },
      dataBindings: [],
      eventBindings: [{ event: 'click', operationId: 'refresh-data' }],
    },
  ],
  operations: [
    {
      id: 'refresh-data',
      operationName: 'http.get',
      executionType: 'builtin',
      inputs: [{ name: 'url', source: 'constant', sourceId: 'https://api.example.com/data' }],
      outputs: [{ name: 'response', target: 'state', targetId: 'data' }],
      triggers: [],
    },
  ],
  layout: { type: 'flex', properties: {} },
  styling: { theme: 'default' },
};

describe('Sharing and Collaboration Integration', () => {
  let sharingService: SharingService;
  let bookmarkManager: BookmarkManager;
  let persistenceService: PersistenceService;
  let store: InvokeMockHandle;

  beforeEach(() => {
    store = installInvokeMock({
      onCommand: (cmd, args) => {
        // Echo the shared contract back the way the Rust command would
        if (cmd === 'share_experience') {
          const now = new Date().toISOString();
          return {
            contract: dashboardContract,
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
            checksum: 'dashboard-checksum',
          };
        }
        return undefined;
      },
    });
    sharingService = new SharingService();
    bookmarkManager = new BookmarkManager();
    persistenceService = new PersistenceService();
  });

  describe('Experience Sharing', () => {
    it('should create a shareable contract with normalized metadata', async () => {
      const shareable = await persistenceService.shareExperience('dashboard-001', {
        title: 'My Analytics Dashboard',
        description: 'A dashboard for tracking business metrics',
        tags: ['analytics', 'dashboard'],
      });

      expect(shareable.contract).toEqual(dashboardContract);
      expect(shareable.metadata.title).toBe('My Analytics Dashboard');
      expect(shareable.metadata.description).toBe('A dashboard for tracking business metrics');
      expect(shareable.metadata.tags).toEqual(['analytics', 'dashboard']);
      // Wire-format snake_case dates map to Date instances
      expect(shareable.metadata.createdAt).toBeInstanceOf(Date);
      expect(shareable.metadata.sharedAt).toBeInstanceOf(Date);
      expect(shareable.version).toBe('1.0.0');
      expect(shareable.checksum).toBe('dashboard-checksum');
    });

    it('should create shareable experiences through the sharing service facade', async () => {
      const shareable = await sharingService.createShareableExperience(
        'dashboard-001',
        dashboardContract,
        {
          title: 'Facade Dashboard',
          description: 'Shared through the facade',
        }
      );

      expect(shareable.metadata.title).toBe('Facade Dashboard');
      expect(shareable.contract).toEqual(dashboardContract);

      const shareCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'share_experience');
      expect(shareCall).toBeDefined();
      expect((shareCall?.[1] as any).title).toBe('Facade Dashboard');
    });

    it('should generate share URLs', async () => {
      const shareUrl = await sharingService.generateShareUrl('dashboard-001');
      expect(shareUrl).toMatch(/^https?:\/\/.+\/share\/.+$/);
    });

    it('should surface share failures as errors', async () => {
      installInvokeMock({
        onCommand: (cmd) => {
          if (cmd === 'share_experience') {
            throw new Error('experience is not persisted');
          }
          return undefined;
        },
      });

      await expect(
        persistenceService.shareExperience('missing-experience', { title: 'Nope' })
      ).rejects.toThrow('Failed to share experience');
    });
  });

  describe('Shareable Contract Validation', () => {
    function validShareable(): ShareableContract {
      return {
        contract: dashboardContract as any,
        metadata: {
          title: 'Valid Dashboard',
          createdAt: new Date(),
          sharedAt: new Date(),
        },
        version: '1.0.0',
        checksum: 'abc123',
      };
    }

    it('should accept a complete shareable contract', async () => {
      const result = await sharingService.validateShareableContract(validShareable());
      expect(result.errors).toEqual([]);
      expect(result.isValid).toBe(true);
    });

    it('should report missing pieces of a shareable contract', async () => {
      const broken = validShareable();
      (broken as any).contract = undefined;
      (broken as any).checksum = undefined;

      const result = await sharingService.validateShareableContract(broken);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Bookmarking', () => {
    it('should bookmark experiences and read them back', async () => {
      const bookmarkId = await bookmarkManager.bookmarkExperience(
        'user-123',
        { contract: dashboardContract },
        { tags: ['analytics', 'favorite'] }
      );

      expect(bookmarkId).toBeDefined();
      expect(store.bookmarks.has(bookmarkId)).toBe(true);

      const bookmark = await bookmarkManager.getBookmark(bookmarkId);
      expect(bookmark).not.toBeNull();
      expect(bookmark?.name).toBe('Shared Dashboard');
      expect(bookmark?.tags).toEqual(['analytics', 'favorite']);
      expect(bookmark?.createdAt).toBeInstanceOf(Date);
      expect((bookmark?.contract as any).elements).toHaveLength(2);
    });

    it('should search bookmarks by name and tags', async () => {
      await bookmarkManager.bookmarkExperience(
        'user-123',
        { contract: { ...dashboardContract, name: 'Revenue Analytics' } },
        { tags: ['analytics', 'revenue'] }
      );
      await bookmarkManager.bookmarkExperience(
        'user-123',
        { contract: { ...dashboardContract, name: 'Monthly Report' } },
        { tags: ['report', 'monthly'] }
      );

      const byName = await bookmarkManager.searchBookmarks('Revenue');
      expect(byName).toHaveLength(1);
      expect(byName[0].name).toBe('Revenue Analytics');

      const byTag = await bookmarkManager.getBookmarksByTags(['analytics']);
      expect(byTag).toHaveLength(1);
      expect(byTag[0].name).toBe('Revenue Analytics');

      const none = await bookmarkManager.searchBookmarks('does-not-exist');
      expect(none).toEqual([]);
    });

    it('should delete bookmarks', async () => {
      const bookmarkId = await bookmarkManager.bookmarkExperience('user-123', {
        contract: dashboardContract,
      });
      expect(store.bookmarks.has(bookmarkId)).toBe(true);

      await bookmarkManager.deleteBookmark(bookmarkId);

      expect(store.bookmarks.has(bookmarkId)).toBe(false);
      const bookmark = await bookmarkManager.getBookmark(bookmarkId);
      expect(bookmark).toBeNull();
    });
  });

  describe('Import and Duplication', () => {
    it('should import a shareable contract exported as JSON', async () => {
      // Reinstall so the import command lands the copy in the same in-memory
      // store the load command reads from.
      store = installInvokeMock({
        onCommand: (cmd, args) => {
          if (cmd === 'import_shared_experience') {
            store.bookmarks.set('imported-1', {
              id: 'imported-1',
              name: 'Imported Dashboard',
              contract: args?.shareableContract?.contract ?? dashboardContract,
              createdAt: new Date().toISOString(),
              lastAccessedAt: new Date().toISOString(),
            });
            return { success: true, experienceId: 'imported-1' };
          }
          return undefined;
        },
      });

      const payload = JSON.stringify({
        contract: dashboardContract,
        metadata: { title: 'Imported Dashboard', createdAt: new Date(), sharedAt: new Date() },
        version: '1.0.0',
        checksum: 'abc123',
      });

      const result = await persistenceService.importExperience(payload, { format: 'json' });

      expect(result.success).toBe(true);
      expect(result.experienceId).toBe('imported-1');
    });

    it('should report import failures instead of throwing', async () => {
      const result = await sharingService.importSharedExperience('this is not json');
      expect(result.success).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should duplicate shared experiences into independent copies', async () => {
      store = installInvokeMock({
        onCommand: (cmd, args) => {
          if (cmd === 'import_shared_experience') {
            store.bookmarks.set('imported-2', {
              id: 'imported-2',
              name: 'Imported Dashboard',
              contract: args?.shareableContract?.contract ?? dashboardContract,
              createdAt: new Date().toISOString(),
              lastAccessedAt: new Date().toISOString(),
            });
            return { success: true, experienceId: 'imported-2' };
          }
          if (cmd === 'duplicate_experience') {
            store.bookmarks.set('dup-1', {
              id: 'dup-1',
              name: args?.newName ?? 'Copy',
              contract: dashboardContract,
              createdAt: new Date().toISOString(),
              lastAccessedAt: new Date().toISOString(),
            });
            return 'dup-1';
          }
          return undefined;
        },
      });

      const shareable: ShareableContract = {
        contract: dashboardContract as any,
        metadata: { title: 'Duplicable', createdAt: new Date(), sharedAt: new Date() },
        version: '1.0.0',
        checksum: 'abc123',
      };

      const duplicated = await sharingService.duplicateSharedExperience(
        shareable,
        'Dashboard Copy'
      );

      expect(duplicated.id).toBe('dup-1');
      expect((duplicated.contract as any).elements).toHaveLength(2);
    });
  });

  describe('Collaboration Sessions', () => {
    it('should create collaboration sessions with the host as first participant', async () => {
      const session = await sharingService.createCollaborationSession(
        'collab-dashboard',
        'host-123'
      );

      expect(session.id).toBeDefined();
      expect(session.experienceId).toBe('collab-dashboard');
      expect(session.hostUserId).toBe('host-123');
      expect(session.participants).toContain('host-123');
      expect(session.isActive).toBe(true);
    });

    it('should start configurable collaboration sessions', async () => {
      const session = await sharingService.startCollaborationSession(
        'realtime-dashboard',
        'host-456',
        { allowEditing: true, maxParticipants: 5 }
      );

      expect(session.hostUserId).toBe('host-456');
      expect(session.allowEditing).toBe(true);
      expect(session.maxParticipants).toBe(5);
      expect(session.createdAt).toBeInstanceOf(Date);
    });
  });
});
