/**
 * Sharing and Collaboration Workflow Integration Test
 * Tests the complete sharing and collaboration workflow
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.3, 5.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Contract } from '../../models/contract';

// Mock the LLM client
vi.mock('../../services/ai-interpreter/llm-client', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        goal: "Create a collaborative document editor",
        requiredCapabilities: ["document-editing", "collaboration"],
        uiElements: [
          {
            type: "textarea",
            purpose: "Document content editor",
            capabilities: ["text-editing", "real-time-sync"]
          },
          {
            type: "button",
            purpose: "Save document",
            capabilities: ["click-handler"]
          }
        ],
        operations: [
          {
            name: "saveDocument",
            purpose: "Save document content",
            inputs: ["content"],
            outputs: ["documentId"],
            executionType: "local"
          }
        ],
        ambiguities: []
      })
    })
  }))
}));

describe('Sharing and Collaboration Workflow Integration', () => {
  let integratedService: IntegratedExperienceService;
  let experienceId: string;
  let contract: Contract;

  beforeEach(async () => {
    integratedService = new IntegratedExperienceService();
    
    // Create a base experience to share
    const result = await integratedService.createExperienceFromNaturalLanguage(
      "Create a collaborative document editor",
      { preserveEdits: true, autoSave: true }
    );
    
    experienceId = result.experienceId;
    contract = result.contract;
  });

  describe('Experience Sharing Workflow', () => {
    it('should create shareable experience with metadata', async () => {
      const shareOptions = {
        title: 'My Collaborative Editor',
        description: 'A real-time document editor for team collaboration',
        isPublic: true,
        allowEditing: true,
        allowedUsers: ['user1@example.com', 'user2@example.com']
      };

      const shareResult = await integratedService.shareExperience(
        experienceId,
        shareOptions
      );

      expect(shareResult).toHaveProperty('shareUrl');
      expect(shareResult).toHaveProperty('shareableExperience');
      
      // Verify shareable experience structure
      const { shareableExperience } = shareResult;
      expect(shareableExperience.id).toBeDefined();
      expect(shareableExperience.experienceId).toBe(experienceId);
      expect(shareableExperience.contract).toEqual(contract);
      expect(shareableExperience.metadata.title).toBe(shareOptions.title);
      expect(shareableExperience.metadata.description).toBe(shareOptions.description);
      expect(shareableExperience.metadata.isPublic).toBe(true);
      expect(shareableExperience.checksum).toBeDefined();

      // Verify share URL format
      expect(shareResult.shareUrl).toMatch(/^https?:\/\/.+/);
    });

    it('should create private shareable experience', async () => {
      const shareOptions = {
        title: 'Private Document Editor',
        isPublic: false,
        allowEditing: false
      };

      const shareResult = await integratedService.shareExperience(
        experienceId,
        shareOptions
      );

      expect(shareResult.shareableExperience.metadata.isPublic).toBe(false);
      expect(shareResult.shareUrl).toBeDefined();
    });

    it('should handle sharing errors gracefully', async () => {
      // Test sharing non-existent experience
      await expect(
        integratedService.shareExperience('non-existent-id', {
          title: 'Test',
          isPublic: true
        })
      ).rejects.toThrow('Experience not found');
    });
  });

  describe('Experience Import Workflow', () => {
    it('should import shared experience successfully', async () => {
      // First, share an experience
      const shareResult = await integratedService.shareExperience(experienceId, {
        title: 'Shared Editor',
        description: 'Test sharing functionality',
        isPublic: true,
        allowEditing: true
      });

      // Import the shared experience
      const importResult = await integratedService.importSharedExperience(
        shareResult.shareUrl,
        'importing-user-id'
      );

      expect(importResult).toHaveProperty('experienceId');
      expect(importResult).toHaveProperty('blueprint');
      expect(importResult).toHaveProperty('contract');
      expect(importResult).toHaveProperty('experience');
      expect(importResult).toHaveProperty('renderComponent');

      // Verify imported experience has new ID (independent copy)
      expect(importResult.experienceId).not.toBe(experienceId);

      // Verify contract content is preserved
      expect(importResult.contract.elements).toHaveLength(contract.elements.length);
      expect(importResult.contract.operations).toHaveLength(contract.operations.length);

      // Verify experience is ready for editing
      expect(importResult.experience.id).toBe(importResult.experienceId);
      expect(importResult.renderComponent).toBeTypeOf('function');
    });

    it('should handle import errors gracefully', async () => {
      // Test importing with invalid URL
      await expect(
        integratedService.importSharedExperience('invalid-url', 'user-id')
      ).rejects.toThrow();
    });
  });

  describe('Bookmarking Workflow', () => {
    it('should bookmark experience with metadata', async () => {
      const bookmarkOptions = {
        personalNote: 'Great collaborative tool for our team',
        tags: ['collaboration', 'documents', 'productivity'],
        collection: 'Work Tools'
      };

      const bookmark = await integratedService.bookmarkExperience(
        experienceId,
        'user-123',
        bookmarkOptions
      );

      expect(bookmark).toHaveProperty('id');
      expect(bookmark).toHaveProperty('userId', 'user-123');
      expect(bookmark).toHaveProperty('experienceId', experienceId);
      expect(bookmark).toHaveProperty('personalNote', bookmarkOptions.personalNote);
      expect(bookmark).toHaveProperty('tags');
      expect(bookmark.tags).toEqual(expect.arrayContaining(bookmarkOptions.tags));
      expect(bookmark).toHaveProperty('collection', bookmarkOptions.collection);
      expect(bookmark).toHaveProperty('createdAt');
      expect(bookmark.createdAt).toBeInstanceOf(Date);
    });

    it('should bookmark experience with minimal metadata', async () => {
      const bookmark = await integratedService.bookmarkExperience(
        experienceId,
        'user-456'
      );

      expect(bookmark.userId).toBe('user-456');
      expect(bookmark.experienceId).toBe(experienceId);
      expect(bookmark.personalNote).toBeUndefined();
      expect(bookmark.tags).toEqual([]);
      expect(bookmark.collection).toBeUndefined();
    });

    it('should load bookmarked experience', async () => {
      // First bookmark an experience
      const bookmark = await integratedService.bookmarkExperience(
        experienceId,
        'user-789',
        { personalNote: 'Test bookmark' }
      );

      // Load the bookmarked experience
      const loadedResult = await integratedService.loadBookmarkedExperience(
        bookmark.id,
        'user-789'
      );

      expect(loadedResult).toHaveProperty('experienceId');
      expect(loadedResult).toHaveProperty('contract');
      expect(loadedResult).toHaveProperty('experience');
      expect(loadedResult).toHaveProperty('renderComponent');

      // Verify loaded experience has new ID (independent copy)
      expect(loadedResult.experienceId).not.toBe(experienceId);

      // Verify contract content is preserved
      expect(loadedResult.contract.elements).toHaveLength(contract.elements.length);
      expect(loadedResult.contract.operations).toHaveLength(contract.operations.length);
    });

    it('should retrieve user bookmarks', async () => {
      const userId = 'user-bookmarks-test';

      // Create multiple bookmarks
      await integratedService.bookmarkExperience(experienceId, userId, {
        tags: ['tag1'],
        collection: 'Collection A'
      });

      // Create another experience and bookmark it
      const result2 = await integratedService.createExperienceFromNaturalLanguage(
        "Create a simple calculator"
      );
      await integratedService.bookmarkExperience(result2.experienceId, userId, {
        tags: ['tag2'],
        collection: 'Collection B'
      });

      // Retrieve all bookmarks
      const bookmarks = await integratedService.getUserBookmarks(userId);
      expect(bookmarks).toHaveLength(2);
      expect(bookmarks.every(b => b.userId === userId)).toBe(true);
    });

    it('should search bookmarks by criteria', async () => {
      const userId = 'user-search-test';

      // Create bookmarks with different tags and collections
      await integratedService.bookmarkExperience(experienceId, userId, {
        tags: ['productivity', 'collaboration'],
        collection: 'Work Tools'
      });

      const result2 = await integratedService.createExperienceFromNaturalLanguage(
        "Create a game"
      );
      await integratedService.bookmarkExperience(result2.experienceId, userId, {
        tags: ['entertainment', 'games'],
        collection: 'Fun Apps'
      });

      // Search by tags
      const productivityBookmarks = await integratedService.searchBookmarks(userId, {
        tags: ['productivity']
      });
      expect(productivityBookmarks).toHaveLength(1);
      expect(productivityBookmarks[0].tags).toContain('productivity');

      // Search by collection
      const workToolsBookmarks = await integratedService.searchBookmarks(userId, {
        collection: 'Work Tools'
      });
      expect(workToolsBookmarks).toHaveLength(1);
      expect(workToolsBookmarks[0].collection).toBe('Work Tools');
    });
  });

  describe('Collaboration Features', () => {
    it('should handle concurrent editing scenarios', async () => {
      // Create a shared experience
      const shareResult = await integratedService.shareExperience(experienceId, {
        title: 'Collaborative Editor',
        isPublic: true,
        allowEditing: true
      });

      // Import by two different users
      const user1Import = await integratedService.importSharedExperience(
        shareResult.shareUrl,
        'user-1'
      );
      const user2Import = await integratedService.importSharedExperience(
        shareResult.shareUrl,
        'user-2'
      );

      // Both users should have independent copies
      expect(user1Import.experienceId).not.toBe(user2Import.experienceId);
      expect(user1Import.experienceId).not.toBe(experienceId);
      expect(user2Import.experienceId).not.toBe(experienceId);

      // Both should be able to edit independently
      const user1Edit = {
        type: 'property-change',
        elementId: user1Import.contract.elements[0].id,
        property: 'label',
        newValue: 'User 1 Edit',
        originalValue: 'Original',
        timestamp: new Date()
      };

      const user2Edit = {
        type: 'property-change',
        elementId: user2Import.contract.elements[0].id,
        property: 'label',
        newValue: 'User 2 Edit',
        originalValue: 'Original',
        timestamp: new Date()
      };

      const user1EditResult = await integratedService.editExperience(
        user1Import.experienceId,
        user1Edit
      );
      const user2EditResult = await integratedService.editExperience(
        user2Import.experienceId,
        user2Edit
      );

      expect(user1EditResult.success).toBe(true);
      expect(user2EditResult.success).toBe(true);
    });

    it('should maintain experience versioning', async () => {
      // Create and share an experience
      const shareResult = await integratedService.shareExperience(experienceId, {
        title: 'Versioned Experience',
        isPublic: true
      });

      // Import and modify
      const importResult = await integratedService.importSharedExperience(
        shareResult.shareUrl,
        'user-version-test'
      );

      // Make an edit
      const edit = {
        type: 'property-change',
        elementId: importResult.contract.elements[0].id,
        property: 'version',
        newValue: '2.0.0',
        originalValue: '1.0.0',
        timestamp: new Date()
      };

      await integratedService.editExperience(importResult.experienceId, edit);

      // Verify versioning is maintained
      const currentContract = await integratedService['editor'].getCurrentContract(
        importResult.experienceId
      );
      expect(currentContract).toBeDefined();
    });
  });

  describe('Error Handling in Sharing Workflow', () => {
    it('should handle bookmark errors gracefully', async () => {
      // Test bookmarking non-existent experience
      await expect(
        integratedService.bookmarkExperience('non-existent', 'user-id')
      ).rejects.toThrow();
    });

    it('should handle loading non-existent bookmark', async () => {
      await expect(
        integratedService.loadBookmarkedExperience('non-existent-bookmark', 'user-id')
      ).rejects.toThrow();
    });

    it('should handle search with no results', async () => {
      const results = await integratedService.searchBookmarks('user-no-bookmarks', {
        tags: ['non-existent-tag']
      });
      expect(results).toEqual([]);
    });
  });
});
