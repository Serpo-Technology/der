/**
 * The standalone experience window rehydrates bootstrap state and persists
 * state changes debounced through save_experience_state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {})
}));

import { invoke } from '@tauri-apps/api/core';
import App from '../App';

const invokeMock = vi.mocked(invoke);

const WINDOW_CONTRACT = {
  name: 'notes',
  version: '1.0.0',
  initialState: { note: 'seed' },
  elements: [
    {
      id: 'note-in',
      type: 'input',
      properties: { placeholder: 'Note' },
      dataBindings: [],
      eventBindings: []
    }
  ],
  operations: [],
  layout: { type: 'flex', properties: {} },
  styling: { theme: 'default' }
};

describe('ExperienceWindow state persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_repository_index') {
        throw new Error('none in tests');
      }
      return {};
    });
    (globalThis as any).__DER_BOOTSTRAP = {
      experienceId: 'app-1',
      contract: WINDOW_CONTRACT,
      state: { 'element_note-in': 'restored draft' }
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (globalThis as any).__DER_BOOTSTRAP;
  });

  function savedStateCalls() {
    return invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_experience_state');
  }

  it('rehydrates the bootstrap state into the rendered app', async () => {
    render(<App />);
    await act(async () => {});

    expect(screen.getByPlaceholderText('Note')).toHaveValue('restored draft');
  });

  it('persists state changes debounced under the experience id', async () => {
    render(<App />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText('Note'), {
      target: { value: 'typed text' }
    });

    // Not saved synchronously.
    expect(savedStateCalls()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    const calls = savedStateCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, args] = calls[calls.length - 1] as [string, any];
    expect(args.experienceId).toBe('app-1');
    expect(args.state['element_note-in']).toBe('typed text');
  });

  it('flushes the pending snapshot on unmount', async () => {
    const { unmount } = render(<App />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText('Note'), {
      target: { value: 'about to close' }
    });
    expect(savedStateCalls()).toHaveLength(0);

    unmount();

    const calls = savedStateCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, args] = calls[calls.length - 1] as [string, any];
    expect(args.state['element_note-in']).toBe('about to close');
  });
});
