/**
 * Sharing and Collaboration Workflow Integration Test
 * Tests sharing, import, and bookmarking through the
 * IntegratedExperienceService. Generation runs against the mocked `llm_chat`
 * command; bookmark storage commands run against an in-memory store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Contract } from '../../models/contract';
import { installInvokeMock, InvokeMockHandle } from '../support/tauri-invoke-mock';

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

describe('Sharing and Collaboration Workflow Integration', () => {
  let integratedService: IntegratedExperienceService;
  let experienceId: string;
  let contract: Contract;
  let store: InvokeMockHandle;

  beforeEach(async () => {
    store = installInvokeMock();
    integratedService = new IntegratedExperienceService();

    const result = await integratedService.createExperienceFromNaturalLanguage(
      'Create a collaborative todo list',
      { preserveEdits: true, autoSave: true }
    );

    experienceId = result.experienceId;
    contract = result.contract;
  });

  describe('Experience Sharing Workflow', () => {
    it('should create a shareable experience with metadata', async () => {
      const shareOptions = {
        title: 'My Collaborative Todos',
        description: 'A todo list for team planning',
        isPublic: true,
        allowEditing: true,
      };

      const shareResult = await integratedService.shareExperience(experienceId, shareOptions);

      expect(shareResult).toHaveProperty('shareUrl');
      expect(shareResult).toHaveProperty('shareableExperience');

      const { shareableExperience } = shareResult;
      expect(shareableExperience.contract).toBeDefined();
      expect(shareableExperience.metadata.title).toBe(shareOptions.title);
      expect(shareableExperience.metadata.description).toBe(shareOptions.description);
      expect(shareableExperience.metadata.createdAt).toBeInstanceOf(Date);
      expect(shareableExperience.metadata.sharedAt).toBeInstanceOf(Date);
      expect(shareableExperience.version).toBe('1.0.0');
      expect(shareableExperience.checksum).toBeDefined();

      expect(shareResult.shareUrl).toMatch(/^https?:\/\/.+\/share\/.+$/);
    });

    it('should handle sharing errors gracefully', async () => {
      await expect(
        integratedService.shareExperience('non-existent-id', {
          title: 'Test',
          isPublic: true,
        })
      ).rejects.toThrow('Experience not found');
    });
  });

  describe('Experience Import Workflow', () => {
    it('should import a shared experience as an independent copy', async () => {
      const shareResult = await integratedService.shareExperience(experienceId, {
        title: 'Shared Todos',
        isPublic: true,
      });

      const importResult = await integratedService.importSharedExperience(
        shareResult.shareUrl,
        'importing-user-id'
      );

      expect(importResult).toHaveProperty('experienceId');
      expect(importResult).toHaveProperty('blueprint');
      expect(importResult).toHaveProperty('contract');
      expect(importResult).toHaveProperty('experience');
      expect(importResult).toHaveProperty('renderComponent');

      // The imported copy gets its own identity
      expect(importResult.experienceId).not.toBe(experienceId);
      expect(importResult.experience.id).toBe(importResult.experienceId);
      expect(importResult.renderComponent).toBeTypeOf('function');
    });
  });

  describe('Bookmarking Workflow', () => {
    it('should bookmark an experience and persist its contract', async () => {
      const bookmark = await integratedService.bookmarkExperience(experienceId, 'user-123', {
        tags: ['collaboration', 'productivity'],
      });

      expect(bookmark.id).toBeDefined();
      expect(bookmark.name).toBe(contract.name);
      expect(bookmark.contract).toBeDefined();
      expect(bookmark.createdAt).toBeInstanceOf(Date);
      expect(bookmark.lastAccessedAt).toBeInstanceOf(Date);
      expect(bookmark.tags).toEqual(['collaboration', 'productivity']);

      // The bookmark commands persisted the full contract
      const stored = store.bookmarks.get(bookmark.id);
      expect(stored).toBeDefined();
      expect((stored?.contract as any).elements).toHaveLength(contract.elements.length);
    });

    it('should load a bookmarked experience as a new editable experience', async () => {
      const bookmark = await integratedService.bookmarkExperience(experienceId, 'user-789');

      const loadedResult = await integratedService.loadBookmarkedExperience(
        bookmark.id,
        'user-789'
      );

      expect(loadedResult).toHaveProperty('experienceId');
      expect(loadedResult).toHaveProperty('contract');
      expect(loadedResult).toHaveProperty('experience');
      expect(loadedResult).toHaveProperty('renderComponent');

      // Independent copy with the preserved contract content
      expect(loadedResult.experienceId).not.toBe(experienceId);
      expect(loadedResult.contract.elements).toHaveLength(contract.elements.length);
      expect(loadedResult.contract.operations).toHaveLength(contract.operations.length);

      // The loaded copy is editable
      const edit = {
        type: 'property-change',
        elementId: loadedResult.contract.elements[0].id,
        property: 'content',
        newValue: 'Loaded copy title',
        originalValue: 'My Todos',
        timestamp: new Date(),
      };
      const editResult = await integratedService.editExperience(loadedResult.experienceId, edit);
      expect(editResult.success).toBe(true);
    });

    it('should search bookmarks by text', async () => {
      await integratedService.bookmarkExperience(experienceId, 'user-search', {
        tags: ['productivity', 'collaboration'],
      });

      const result2 = await integratedService.createExperienceFromNaturalLanguage(
        'Create a second todo list'
      );
      await integratedService.bookmarkExperience(result2.experienceId, 'user-search', {
        tags: ['games'],
      });

      const productivityBookmarks = await integratedService.searchBookmarks('user-search', {
        query: 'productivity',
      });
      expect(productivityBookmarks).toHaveLength(1);
      expect(productivityBookmarks[0].tags).toContain('productivity');

      const noMatches = await integratedService.searchBookmarks('user-search', {
        query: 'no-such-term',
      });
      expect(noMatches).toEqual([]);
    });
  });

  describe('Error Handling in Sharing Workflow', () => {
    it('should handle bookmark errors gracefully', async () => {
      await expect(
        integratedService.bookmarkExperience('non-existent', 'user-id')
      ).rejects.toThrow();
    });

    it('should handle loading a non-existent bookmark', async () => {
      await expect(
        integratedService.loadBookmarkedExperience('non-existent-bookmark', 'user-id')
      ).rejects.toThrow('Bookmark not found');
    });
  });
});
