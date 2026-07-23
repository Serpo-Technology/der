/**
 * End-to-end run of a todo contract in the shape the prompt teaches (based
 * on a local 7B model's output, with the visible-completion pattern applied:
 * filterFalsy remaining count and a className map on the row text). Guards
 * the event scope row buttons rely on and the visibility of toggled flags.
 */

import { describe, it, expect } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamicExperienceRenderer } from '../components/runtime/DynamicExperienceRenderer';
import type { Contract } from '../types/contract';

const contract = JSON.parse(
  readFileSync(join(__dirname, '../test/fixtures-todo-local.json'), 'utf8')
) as Contract;

describe('local-model todo app end to end', () => {
  it('adds a task and marks it complete', async () => {
    const view = render(
      <DynamicExperienceRenderer contract={contract} experienceId="todo-live" />
    );

    const input = await waitFor(() => {
      const el = view.container.querySelector('input');
      expect(el).toBeTruthy();
      return el!;
    });

    await act(async () => {
      fireEvent.change(input, { target: { value: 'buy milk' } });
    });
    await act(async () => {
      fireEvent.click(view.getByText('Add Task'));
    });

    await waitFor(() => expect(view.container.textContent).toContain('buy milk'));
    // A fresh task should count as remaining.
    expect(view.container.textContent).toContain('1 tasks left');

    await act(async () => {
      fireEvent.click(view.getByText('Complete'));
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('0 tasks left');
      const row = view.getByText('buy milk');
      expect(row.className).toContain('done');
    });
  });
});
