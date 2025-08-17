/**
 * Bookmark Manager - High-level bookmark management service
 * Requirements: 4.1, 4.2
 */

import { BookmarkedExperience } from '../../types/persistence';
import { Experience } from '../../types/experience';
import { persistenceService } from './PersistenceService';

export interface BookmarkFilter {
  tags?: string[];
  category?: string;
  searchTerm?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
}

export interface BookmarkSortOptions {
  field: 'name' | 'createdAt' | 'lastAccessedAt';
  direction: 'asc' | 'desc';
}

export class BookmarkManager {
  /**
   * Create a bookmark from an experience
   */
  async createBookmark(experience: Experience, tags?: string[]): Promise<string> {
    try {
      // Add tags to contract metadata if provided
      if (tags && tags.length > 0) {
        if (!experience.contract.metadata) {
          experience.contract.metadata = {
            createdAt: new Date(),
            updatedAt: new Date(),
            version: experience.contract.version || '1.0.0'
          };
        }
        experience.contract.metadata.tags = tags;
      }

      return await persistenceService.bookmarkExperience(experience);
    } catch (error) {
      throw new Error(`Failed to create bookmark: ${error}`);
    }
  }

  /**
   * Alias for createBookmark to match test expectations
   */
  async bookmarkExperience(
    userId: string, 
    shareableExperience: any, 
    options: { tags?: string[]; collection?: string } = {}
  ): Promise<string> {
    // Convert shareable experience to Experience format
    const experienceId = `bookmark-${Date.now()}`;
    const experience: Experience = {
      id: experienceId,
      experienceId: experienceId,
      contract: shareableExperience.contract || shareableExperience,
      state: {},
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0',
        userId: userId,
        collection: options.collection
      }
    };

    return this.createBookmark(experience, options.tags);
  }

  /**
   * Get bookmarks by collection
   */
  async getBookmarksByCollection(userId: string, collection: string): Promise<BookmarkedExperience[]> {
    try {
      const filter: BookmarkFilter = {
        // Add collection filtering logic here
      };
      
      const bookmarks = await this.getBookmarks(filter);
      return bookmarks.filter(bookmark => {
        // Check if bookmark has the required collection in tags or metadata
        const hasCollection = bookmark.tags?.includes(collection) ||
                             (bookmark.contract.metadata as any)?.collection === collection;
        return hasCollection;
      });
    } catch (error) {
      throw new Error(`Failed to get bookmarks by collection: ${error}`);
    }
  }

  /**
   * Get all bookmarks for a user
   */
  async getAllBookmarks(userId: string): Promise<BookmarkedExperience[]> {
    try {
      const bookmarks = await this.getBookmarks();
      return bookmarks.filter(bookmark => 
        (bookmark.contract.metadata as any)?.userId === userId
      );
    } catch (error) {
      throw new Error(`Failed to get all bookmarks: ${error}`);
    }
  }

  /**
   * Get all bookmarks with optional filtering and sorting
   */
  async getBookmarks(
    filter?: BookmarkFilter,
    sort?: BookmarkSortOptions
  ): Promise<BookmarkedExperience[]> {
    try {
      let bookmarks = await persistenceService.listBookmarkedExperiences();

      // Apply filters
      if (filter) {
        bookmarks = this.applyFilters(bookmarks, filter);
      }

      // Apply sorting
      if (sort) {
        bookmarks = this.applySorting(bookmarks, sort);
      }

      return bookmarks;
    } catch (error) {
      throw new Error(`Failed to get bookmarks: ${error}`);
    }
  }

  /**
   * Get a specific bookmark by ID
   */
  async getBookmark(id: string): Promise<BookmarkedExperience | null> {
    try {
      const bookmarks = await persistenceService.listBookmarkedExperiences();
      return bookmarks.find(bookmark => bookmark.id === id) || null;
    } catch (error) {
      throw new Error(`Failed to get bookmark: ${error}`);
    }
  }

  /**
   * Update bookmark metadata (name, description, tags)
   */
  async updateBookmarkMetadata(
    id: string,
    updates: {
      name?: string;
      description?: string;
      tags?: string[];
    }
  ): Promise<void> {
    try {
      const experience = await persistenceService.loadBookmarkedExperience(id);
      if (!experience) {
        throw new Error('Bookmark not found');
      }

      // Update contract metadata
      if (!experience.contract.metadata) {
        experience.contract.metadata = {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: experience.contract.version || '1.0.0'
        };
      }

      if (updates.name) {
        experience.contract.name = updates.name;
      }
      if (updates.description !== undefined) {
        experience.contract.metadata.description = updates.description;
      }
      if (updates.tags) {
        experience.contract.metadata.tags = updates.tags;
      }

      // Save the updated experience
      await persistenceService.updateExperience(id, {
        contract: experience.contract,
        preserveUserEdits: true
      });
    } catch (error) {
      throw new Error(`Failed to update bookmark metadata: ${error}`);
    }
  }

  /**
   * Delete a bookmark
   */
  async deleteBookmark(id: string): Promise<void> {
    try {
      await persistenceService.deleteBookmarkedExperience(id);
    } catch (error) {
      throw new Error(`Failed to delete bookmark: ${error}`);
    }
  }

  /**
   * Search bookmarks by text
   */
  async searchBookmarks(searchTerm: string): Promise<BookmarkedExperience[]> {
    try {
      const filter: BookmarkFilter = { searchTerm };
      return await this.getBookmarks(filter);
    } catch (error) {
      throw new Error(`Failed to search bookmarks: ${error}`);
    }
  }

  /**
   * Get bookmarks by tags
   */
  async getBookmarksByTags(tags: string[]): Promise<BookmarkedExperience[]> {
    try {
      const filter: BookmarkFilter = { tags };
      return await this.getBookmarks(filter);
    } catch (error) {
      throw new Error(`Failed to get bookmarks by tags: ${error}`);
    }
  }

  /**
   * Get recently accessed bookmarks
   */
  async getRecentBookmarks(limit: number = 10): Promise<BookmarkedExperience[]> {
    try {
      const sort: BookmarkSortOptions = {
        field: 'lastAccessedAt',
        direction: 'desc'
      };
      const bookmarks = await this.getBookmarks(undefined, sort);
      return bookmarks.slice(0, limit);
    } catch (error) {
      throw new Error(`Failed to get recent bookmarks: ${error}`);
    }
  }

  /**
   * Apply filters to bookmark list
   */
  private applyFilters(bookmarks: BookmarkedExperience[], filter: BookmarkFilter): BookmarkedExperience[] {
    return bookmarks.filter(bookmark => {
      // Tag filter
      if (filter.tags && filter.tags.length > 0) {
        const bookmarkTags = bookmark.tags || [];
        const hasMatchingTag = filter.tags.some(tag => 
          bookmarkTags.some(bookmarkTag => 
            bookmarkTag.toLowerCase().includes(tag.toLowerCase())
          )
        );
        if (!hasMatchingTag) return false;
      }

      // Search term filter
      if (filter.searchTerm) {
        const searchTerm = filter.searchTerm.toLowerCase();
        const matchesName = bookmark.name.toLowerCase().includes(searchTerm);
        const matchesDescription = bookmark.description?.toLowerCase().includes(searchTerm) || false;
        const matchesTags = bookmark.tags?.some(tag => 
          tag.toLowerCase().includes(searchTerm)
        ) || false;
        
        if (!matchesName && !matchesDescription && !matchesTags) return false;
      }

      // Date range filter
      if (filter.dateRange) {
        const bookmarkDate = bookmark.createdAt;
        if (bookmarkDate < filter.dateRange.start || bookmarkDate > filter.dateRange.end) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Apply sorting to bookmark list
   */
  private applySorting(bookmarks: BookmarkedExperience[], sort: BookmarkSortOptions): BookmarkedExperience[] {
    return bookmarks.sort((a, b) => {
      let aValue: any;
      let bValue: any;

      switch (sort.field) {
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'createdAt':
          aValue = a.createdAt.getTime();
          bValue = b.createdAt.getTime();
          break;
        case 'lastAccessedAt':
          aValue = a.lastAccessedAt.getTime();
          bValue = b.lastAccessedAt.getTime();
          break;
        default:
          return 0;
      }

      if (sort.direction === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });
  }
}

// Export singleton instance
export const bookmarkManager = new BookmarkManager();