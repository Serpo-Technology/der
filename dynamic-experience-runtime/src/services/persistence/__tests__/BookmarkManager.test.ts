/**
 * Tests for BookmarkManager
 * Requirements: 4.1, 4.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BookmarkManager } from '../BookmarkManager';
import { BookmarkedExperience } from '../../../types/persistence';
import { Experience } from '../../../types/experience';
import { Contract } from '../../../types/contract';
import { persistenceService } from '../PersistenceService';

// Mock the persistence service
vi.mock('../PersistenceService', () => ({
  persistenceService: {
    bookmarkExperience: vi.fn(),
    listBookmarkedExperiences: vi.fn(),
    loadBookmarkedExperience: vi.fn(),
    deleteBookmarkedExperience: vi.fn(),
    updateExperience: vi.fn()
  }
}));

describe('BookmarkManager', () => {
  let bookmarkManager: BookmarkManager;
  let mockExperience: Experience;
  let mockBookmarks: BookmarkedExperience[];
  let mockPersistenceService: any;

  beforeEach(() => {
    bookmarkManager = new BookmarkManager();
    mockPersistenceService = vi.mocked(persistenceService);
    vi.clearAllMocks();

    const mockContract: Contract = {
      name: 'Test Experience',
      version: '1.0.0',
      elements: [],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        version: '1.0.0',
        description: 'Test description',
        tags: ['test', 'demo']
      }
    };

    mockExperience = {
      id: 'test-experience-1',
      contract: mockContract,
      reactComponent: () => null,
      state: {
        data: {},
        loading: {},
        errors: {},
        lastUpdated: new Date()
      },
      operations: new Map()
    };

    mockBookmarks = [
      {
        id: 'bookmark-1',
        name: 'First Bookmark',
        description: 'First test bookmark',
        contract: mockContract,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        lastAccessedAt: new Date('2024-01-02T00:00:00Z'),
        tags: ['test', 'first']
      },
      {
        id: 'bookmark-2',
        name: 'Second Bookmark',
        description: 'Second test bookmark',
        contract: mockContract,
        createdAt: new Date('2024-01-03T00:00:00Z'),
        lastAccessedAt: new Date('2024-01-04T00:00:00Z'),
        tags: ['demo', 'second']
      },
      {
        id: 'bookmark-3',
        name: 'Third Bookmark',
        description: 'Contains search term',
        contract: mockContract,
        createdAt: new Date('2024-01-05T00:00:00Z'),
        lastAccessedAt: new Date('2024-01-06T00:00:00Z'),
        tags: ['special']
      }
    ];
  });

  describe('createBookmark', () => {
    it('should create a bookmark with tags', async () => {
      mockPersistenceService.bookmarkExperience.mockResolvedValue('bookmark-123');

      const result = await bookmarkManager.createBookmark(mockExperience, ['custom', 'tag']);

      expect(result).toBe('bookmark-123');
      expect(mockExperience.contract.metadata?.tags).toEqual(['custom', 'tag']);
      expect(mockPersistenceService.bookmarkExperience).toHaveBeenCalledWith(mockExperience);
    });

    it('should create a bookmark without tags', async () => {
      mockPersistenceService.bookmarkExperience.mockResolvedValue('bookmark-123');

      const result = await bookmarkManager.createBookmark(mockExperience);

      expect(result).toBe('bookmark-123');
      expect(mockPersistenceService.bookmarkExperience).toHaveBeenCalledWith(mockExperience);
    });

    it('should handle bookmark creation failure', async () => {
      mockPersistenceService.bookmarkExperience.mockRejectedValue(new Error('Storage error'));

      await expect(bookmarkManager.createBookmark(mockExperience))
        .rejects.toThrow('Failed to create bookmark: Error: Storage error');
    });
  });

  describe('getBookmarks', () => {
    it('should return all bookmarks without filters', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarks();

      expect(result).toEqual(mockBookmarks);
      expect(mockPersistenceService.listBookmarkedExperiences).toHaveBeenCalled();
    });

    it('should filter bookmarks by tags', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarks({ tags: ['test'] });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('bookmark-1');
    });

    it('should filter bookmarks by search term', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarks({ searchTerm: 'search term' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('bookmark-3');
    });

    it('should filter bookmarks by date range', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarks({
        dateRange: {
          start: new Date('2024-01-02T00:00:00Z'),
          end: new Date('2024-01-04T00:00:00Z')
        }
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('bookmark-2');
    });

    it('should sort bookmarks by name ascending', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarks(
        undefined,
        { field: 'name', direction: 'asc' }
      );

      expect(result[0].name).toBe('First Bookmark');
      expect(result[1].name).toBe('Second Bookmark');
      expect(result[2].name).toBe('Third Bookmark');
    });

    it('should sort bookmarks by lastAccessedAt descending', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarks(
        undefined,
        { field: 'lastAccessedAt', direction: 'desc' }
      );

      expect(result[0].id).toBe('bookmark-3');
      expect(result[1].id).toBe('bookmark-2');
      expect(result[2].id).toBe('bookmark-1');
    });
  });

  describe('getBookmark', () => {
    it('should return specific bookmark by ID', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmark('bookmark-2');

      expect(result).toBeDefined();
      expect(result!.id).toBe('bookmark-2');
      expect(result!.name).toBe('Second Bookmark');
    });

    it('should return null for non-existent bookmark', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmark('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('updateBookmarkMetadata', () => {
    it('should update bookmark name and description', async () => {
      mockPersistenceService.loadBookmarkedExperience.mockResolvedValue(mockExperience);
      mockPersistenceService.updateExperience.mockResolvedValue(undefined);

      await bookmarkManager.updateBookmarkMetadata('test-experience-1', {
        name: 'Updated Name',
        description: 'Updated description'
      });

      expect(mockExperience.contract.name).toBe('Updated Name');
      expect(mockExperience.contract.metadata?.description).toBe('Updated description');
      expect(mockPersistenceService.updateExperience).toHaveBeenCalledWith('test-experience-1', {
        contract: mockExperience.contract,
        preserveUserEdits: true
      });
    });

    it('should update bookmark tags', async () => {
      mockPersistenceService.loadBookmarkedExperience.mockResolvedValue(mockExperience);
      mockPersistenceService.updateExperience.mockResolvedValue(undefined);

      await bookmarkManager.updateBookmarkMetadata('test-experience-1', {
        tags: ['updated', 'tags']
      });

      expect(mockExperience.contract.metadata?.tags).toEqual(['updated', 'tags']);
    });

    it('should handle non-existent bookmark', async () => {
      mockPersistenceService.loadBookmarkedExperience.mockResolvedValue(null);

      await expect(bookmarkManager.updateBookmarkMetadata('non-existent', { name: 'New Name' }))
        .rejects.toThrow('Failed to update bookmark metadata: Error: Bookmark not found');
    });
  });

  describe('deleteBookmark', () => {
    it('should delete a bookmark', async () => {
      mockPersistenceService.deleteBookmarkedExperience.mockResolvedValue(undefined);

      await bookmarkManager.deleteBookmark('bookmark-1');

      expect(mockPersistenceService.deleteBookmarkedExperience).toHaveBeenCalledWith('bookmark-1');
    });

    it('should handle deletion failure', async () => {
      mockPersistenceService.deleteBookmarkedExperience.mockRejectedValue(new Error('Delete failed'));

      await expect(bookmarkManager.deleteBookmark('bookmark-1'))
        .rejects.toThrow('Failed to delete bookmark: Error: Delete failed');
    });
  });

  describe('searchBookmarks', () => {
    it('should search bookmarks by term', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.searchBookmarks('First');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('First Bookmark');
    });
  });

  describe('getBookmarksByTags', () => {
    it('should get bookmarks by tags', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getBookmarksByTags(['demo']);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('bookmark-2');
    });
  });

  describe('getRecentBookmarks', () => {
    it('should get recent bookmarks with default limit', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getRecentBookmarks();

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('bookmark-3'); // Most recent
    });

    it('should respect custom limit', async () => {
      mockPersistenceService.listBookmarkedExperiences.mockResolvedValue(mockBookmarks);

      const result = await bookmarkManager.getRecentBookmarks(2);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('bookmark-3');
      expect(result[1].id).toBe('bookmark-2');
    });
  });
});