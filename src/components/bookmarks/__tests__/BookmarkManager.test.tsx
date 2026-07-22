/**
 * The webview has no native confirm dialog, so deletion must work through the
 * card's own two-step confirmation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { BookmarkManager } from '../BookmarkManager';
import { bookmarkManager } from '../../../services/persistence';
import type { BookmarkedExperience } from '../../../types/persistence';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../../services/persistence', () => ({
  bookmarkManager: {
    getBookmarks: vi.fn(),
    getBookmark: vi.fn(),
    deleteBookmark: vi.fn()
  }
}));

const sampleBookmark = {
  id: 'exp-1',
  name: 'Score Tracker',
  contract: { name: 'score-tracker' },
  createdAt: new Date('2026-07-01T10:00:00Z'),
  lastAccessedAt: new Date('2026-07-02T10:00:00Z'),
  tags: []
} as unknown as BookmarkedExperience;

describe('BookmarkManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bookmarkManager.getBookmarks).mockResolvedValue([sampleBookmark]);
    vi.mocked(bookmarkManager.deleteBookmark).mockResolvedValue(undefined);
  });

  it('deletes only after the second click on the armed button', async () => {
    render(<BookmarkManager />);
    expect(await screen.findByText('Score Tracker')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete'));
    expect(bookmarkManager.deleteBookmark).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Click again to delete'));
    await waitFor(() => expect(bookmarkManager.deleteBookmark).toHaveBeenCalledWith('exp-1'));
  });

  it('notifies the host after a deletion so bookmark counts stay current', async () => {
    const onChanged = vi.fn();
    render(<BookmarkManager onBookmarksChanged={onChanged} />);
    expect(await screen.findByText('Score Tracker')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Click again to delete'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows a share action when the host provides one', async () => {
    const onShare = vi.fn();
    render(<BookmarkManager onShare={onShare} />);
    expect(await screen.findByText('Score Tracker')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Share'));
    expect(onShare).toHaveBeenCalledWith('exp-1', 'Score Tracker');
  });
});
