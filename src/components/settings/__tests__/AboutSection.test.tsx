/**
 * The About section carries the attribution NOTICE requires forks to keep,
 * and its links must leave the desktop webview for the default browser.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AboutSection } from '../AboutSection';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const w = window as unknown as Record<string, unknown>;

describe('AboutSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openUrl).mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete w.__TAURI__;
  });

  it('shows the attribution, copyright, and license links', () => {
    render(<AboutSection />);
    expect(
      screen.getByText(/DER \(Dynamic Experience Runtime\) was originally created by Seyit Gokce\./)
    ).toBeInTheDocument();
    expect(screen.getByText('Copyright (C) 2025-2026 Serpo Technology Inc.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'License' })).toHaveAttribute(
      'href',
      'https://github.com/Serpo-Technology/der/blob/main/LICENSE'
    );
    expect(screen.getByRole('link', { name: 'Additional terms' })).toHaveAttribute(
      'href',
      'https://github.com/Serpo-Technology/der/blob/main/NOTICE'
    );
  });

  it('opens links in the default browser inside the desktop shell', () => {
    w.__TAURI__ = {};
    render(<AboutSection />);
    fireEvent.click(screen.getByRole('link', { name: 'Source code' }));
    expect(openUrl).toHaveBeenCalledWith('https://github.com/Serpo-Technology/der');
  });

  it('leaves links to the browser outside the desktop shell', () => {
    render(<AboutSection />);
    fireEvent.click(screen.getByRole('link', { name: 'Source code' }));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
