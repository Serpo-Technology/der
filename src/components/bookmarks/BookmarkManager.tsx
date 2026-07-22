/**
 * Bookmark Manager Component - UI for managing bookmarked experiences
 * Requirements: 4.1, 4.2
 */

import React, { useState, useEffect, useCallback } from 'react';
import { BookmarkedExperience } from '../../types/persistence';
import { bookmarkManager, BookmarkFilter, BookmarkSortOptions } from '../../services/persistence';
import { invoke } from '@tauri-apps/api/core';
import './BookmarkManager.css';

interface BookmarkManagerProps {
  onError?: (error: string) => void;
  onShare?: (id: string, name: string) => void;
  onBookmarksChanged?: () => void;
}

export const BookmarkManager: React.FC<BookmarkManagerProps> = ({
  onError,
  onShare,
  onBookmarksChanged
}) => {
  const [bookmarks, setBookmarks] = useState<BookmarkedExperience[]>([]);
  const [filteredBookmarks, setFilteredBookmarks] = useState<BookmarkedExperience[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<BookmarkSortOptions>({
    field: 'lastAccessedAt',
    direction: 'desc'
  });
  const [showFilters, setShowFilters] = useState(false);

  // Load bookmarks
  const loadBookmarks = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter: BookmarkFilter = {
        searchTerm: searchTerm || undefined,
        tags: selectedTags.length > 0 ? selectedTags : undefined
      };

      const result = await bookmarkManager.getBookmarks(filter, sortBy);
      setBookmarks(result);
      setFilteredBookmarks(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load bookmarks';
      onError?.(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [searchTerm, selectedTags, sortBy, onError]);

  // Load bookmarks on mount and when filters change
  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  // Get all available tags
  const availableTags = React.useMemo(() => {
    const tagSet = new Set<string>();
    bookmarks.forEach(bookmark => {
      bookmark.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [bookmarks]);

  // Open a bookmark as its own app window
  const handleOpenAsApp = useCallback(async (bookmarkId: string) => {
    try {
      const record = await bookmarkManager.getBookmark(bookmarkId);
      if (!record) {
        onError?.('Bookmark not found');
        return;
      }
      await invoke('open_experience_window', {
        experienceId: record.id,
        contract: record.contract,
        title: record.name
      });
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to open app');
    }
  }, [onError]);

  // Handle bookmark deletion (confirmation happens on the card itself)
  const handleDeleteBookmark = useCallback(async (bookmarkId: string) => {
    setIsLoading(true);
    try {
      await bookmarkManager.deleteBookmark(bookmarkId);
      await loadBookmarks(); // Refresh the list
      onBookmarksChanged?.();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete bookmark';
      onError?.(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [loadBookmarks, onError, onBookmarksChanged]);

  // Handle tag toggle
  const handleTagToggle = useCallback((tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  }, []);

  // Handle sort change
  const handleSortChange = useCallback((field: BookmarkSortOptions['field']) => {
    setSortBy(prev => ({
      field,
      direction: prev.field === field && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  }, []);

  // Clear filters
  const clearFilters = useCallback(() => {
    setSearchTerm('');
    setSelectedTags([]);
  }, []);

  return (
    <div className="bookmark-manager">
      <div className="bookmark-header">
        <h2>Bookmarked Experiences</h2>
        <div className="bookmark-actions">
          <button
            className="filter-toggle"
            onClick={() => setShowFilters(!showFilters)}
          >
            {showFilters ? 'Hide Filters' : 'Show Filters'}
          </button>
          <button
            className="refresh-button"
            onClick={loadBookmarks}
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="bookmark-filters">
          <div className="search-filter">
            <input
              type="text"
              placeholder="Search bookmarks..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>

          <div className="tag-filter">
            <label>Filter by tags:</label>
            <div className="tag-list">
              {availableTags.map(tag => (
                <button
                  key={tag}
                  className={`tag-button ${selectedTags.includes(tag) ? 'selected' : ''}`}
                  onClick={() => handleTagToggle(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <div className="sort-options">
            <label>Sort by:</label>
            <div className="sort-buttons">
              <button
                className={`sort-button ${sortBy.field === 'name' ? 'active' : ''}`}
                onClick={() => handleSortChange('name')}
              >
                Name {sortBy.field === 'name' && (sortBy.direction === 'asc' ? '↑' : '↓')}
              </button>
              <button
                className={`sort-button ${sortBy.field === 'createdAt' ? 'active' : ''}`}
                onClick={() => handleSortChange('createdAt')}
              >
                Created {sortBy.field === 'createdAt' && (sortBy.direction === 'asc' ? '↑' : '↓')}
              </button>
              <button
                className={`sort-button ${sortBy.field === 'lastAccessedAt' ? 'active' : ''}`}
                onClick={() => handleSortChange('lastAccessedAt')}
              >
                Last Accessed {sortBy.field === 'lastAccessedAt' && (sortBy.direction === 'asc' ? '↑' : '↓')}
              </button>
            </div>
          </div>

          <button className="clear-filters" onClick={clearFilters}>
            Clear Filters
          </button>
        </div>
      )}

      {/* Bookmark List */}
      <div className="bookmark-list">
        {isLoading && bookmarks.length === 0 ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Loading bookmarks...</p>
          </div>
        ) : filteredBookmarks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📚</div>
            <h3>No Bookmarks Found</h3>
            <p>
              {searchTerm || selectedTags.length > 0 
                ? 'No bookmarks match your current filters.'
                : 'Create and bookmark your first experience to see it here.'
              }
            </p>
          </div>
        ) : (
          <div className="bookmark-grid">
            {filteredBookmarks.map(bookmark => (
              <BookmarkCard
                key={bookmark.id}
                bookmark={bookmark}
                onOpenWindow={() => handleOpenAsApp(bookmark.id)}
                onShare={onShare ? () => onShare(bookmark.id, bookmark.name) : undefined}
                onDelete={() => handleDeleteBookmark(bookmark.id)}
                isLoading={isLoading}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Bookmark Card Component
interface BookmarkCardProps {
  bookmark: BookmarkedExperience;
  onOpenWindow: () => void;
  onShare?: () => void;
  onDelete: () => void;
  isLoading: boolean;
}

const BookmarkCard: React.FC<BookmarkCardProps> = ({
  bookmark,
  onOpenWindow,
  onShare,
  onDelete,
  isLoading
}) => {
  // First click arms the delete, second click performs it; the armed state
  // falls back after a few seconds.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  const handleDeleteClick = () => {
    if (confirmingDelete) {
      setConfirmingDelete(false);
      onDelete();
    } else {
      setConfirmingDelete(true);
    }
  };

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };

  return (
    <div className="bookmark-card">
      {bookmark.thumbnail && (
        <div className="bookmark-thumbnail">
          <img src={bookmark.thumbnail} alt={bookmark.name} />
        </div>
      )}
      
      <div className="bookmark-content">
        <div className="bookmark-header">
          <h3 className="bookmark-name">{bookmark.name}</h3>
          <div className="bookmark-dates">
            <span className="created-date">
              Created: {formatDate(bookmark.createdAt)}
            </span>
            <span className="accessed-date">
              Last accessed: {formatDate(bookmark.lastAccessedAt)}
            </span>
          </div>
        </div>

        {bookmark.description && (
          <p className="bookmark-description">{bookmark.description}</p>
        )}

        {bookmark.tags && bookmark.tags.length > 0 && (
          <div className="bookmark-tags">
            {bookmark.tags.map(tag => (
              <span key={tag} className="bookmark-tag">{tag}</span>
            ))}
          </div>
        )}

        <div className="bookmark-actions">
          <button
            className="load-button primary"
            onClick={onOpenWindow}
            disabled={isLoading}
            title="Open in its own window"
          >
            Open app
          </button>
          {onShare && (
            <button
              className="load-button"
              onClick={onShare}
              disabled={isLoading}
              title="Share this app"
            >
              Share
            </button>
          )}
          <button
            className={`delete-button danger ${confirmingDelete ? 'confirming' : ''}`}
            onClick={handleDeleteClick}
            disabled={isLoading}
            title={confirmingDelete ? 'Click again to delete' : 'Delete bookmark'}
          >
            {confirmingDelete ? 'Click again to delete' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};