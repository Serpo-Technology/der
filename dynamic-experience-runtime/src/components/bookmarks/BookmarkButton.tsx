/**
 * Bookmark Button Component - Quick bookmark/unbookmark functionality
 * Requirements: 4.1, 4.2
 */

import React, { useState, useCallback } from 'react';
import { Experience } from '../../types/experience';
import { bookmarkManager } from '../../services/persistence';
import './BookmarkButton.css';

interface BookmarkButtonProps {
  experience: Experience;
  isBookmarked?: boolean;
  onBookmarkChange?: (isBookmarked: boolean) => void;
  onError?: (error: string) => void;
  onSuccess?: (message: string) => void;
  size?: 'small' | 'medium' | 'large';
  variant?: 'icon' | 'text' | 'full';
  className?: string;
}

export const BookmarkButton: React.FC<BookmarkButtonProps> = ({
  experience,
  isBookmarked = false,
  onBookmarkChange,
  onError,
  onSuccess,
  size = 'medium',
  variant = 'icon',
  className = ''
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [bookmarked, setBookmarked] = useState(isBookmarked);

  // Handle bookmark toggle
  const handleToggleBookmark = useCallback(async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    setIsProcessing(true);
    try {
      if (bookmarked) {
        // Remove bookmark
        await bookmarkManager.deleteBookmark(experience.id);
        setBookmarked(false);
        onBookmarkChange?.(false);
        onSuccess?.('Bookmark removed');
      } else {
        // Add bookmark
        const tags = experience.contract.metadata?.tags || [];
        await bookmarkManager.createBookmark(experience, tags);
        setBookmarked(true);
        onBookmarkChange?.(true);
        onSuccess?.('Experience bookmarked');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update bookmark';
      onError?.(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [experience, bookmarked, onBookmarkChange, onError, onSuccess]);

  const getButtonContent = () => {
    const icon = bookmarked ? '🔖' : '📑';
    const text = bookmarked ? 'Bookmarked' : 'Bookmark';
    
    switch (variant) {
      case 'icon':
        return <span className="bookmark-icon">{icon}</span>;
      case 'text':
        return <span className="bookmark-text">{text}</span>;
      case 'full':
        return (
          <>
            <span className="bookmark-icon">{icon}</span>
            <span className="bookmark-text">{text}</span>
          </>
        );
      default:
        return <span className="bookmark-icon">{icon}</span>;
    }
  };

  const getTitle = () => {
    if (isProcessing) {
      return bookmarked ? 'Removing bookmark...' : 'Adding bookmark...';
    }
    return bookmarked ? 'Remove bookmark' : 'Add bookmark';
  };

  return (
    <button
      className={`bookmark-button ${size} ${variant} ${bookmarked ? 'bookmarked' : 'not-bookmarked'} ${isProcessing ? 'processing' : ''} ${className}`}
      onClick={handleToggleBookmark}
      disabled={isProcessing}
      title={getTitle()}
      aria-label={getTitle()}
    >
      {isProcessing ? (
        <span className="bookmark-spinner">⏳</span>
      ) : (
        getButtonContent()
      )}
    </button>
  );
};