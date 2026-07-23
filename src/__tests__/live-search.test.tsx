/**
 * Live search through dynamic transform parameters: a list filtered by
 * filterContains whose value references the search input element.
 */

import { describe, it, expect } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { DynamicExperienceRenderer } from '../components/runtime/DynamicExperienceRenderer';
import type { Contract } from '../types/contract';

const contract = {
  name: 'search-demo',
  version: '1.0.0',
  initialState: {
    rows: [
      { id: 'a', title: 'Buy milk' },
      { id: 'b', title: 'Call mom' },
      { id: 'c', title: 'Milk the cows' }
    ]
  },
  elements: [
    {
      id: 'search-in',
      type: 'input',
      properties: { placeholder: 'Search tasks' },
      dataBindings: [],
      eventBindings: []
    },
    {
      id: 'rows-list',
      type: 'list',
      properties: { emptyText: 'No matches' },
      dataBindings: [
        {
          property: 'items',
          source: 'state',
          sourceId: 'rows',
          transforms: [
            {
              type: 'filterContains',
              parameters: {
                field: 'title',
                value: { source: 'element', sourceId: 'search-in' }
              }
            }
          ]
        }
      ],
      eventBindings: [],
      children: [
        {
          id: 'r-title',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
          eventBindings: []
        }
      ]
    }
  ],
  operations: []
} as unknown as Contract;

describe('live search via dynamic transform parameters', () => {
  it('filters the list as the search box changes', async () => {
    const view = render(
      <DynamicExperienceRenderer contract={contract} experienceId="search-demo" />
    );

    await waitFor(() => expect(view.container.textContent).toContain('Call mom'));
    expect(view.container.textContent).toContain('Buy milk');

    const input = view.container.querySelector('input')!;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'milk' } });
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('Buy milk');
      expect(view.container.textContent).toContain('Milk the cows');
      expect(view.container.textContent).not.toContain('Call mom');
    });

    await act(async () => {
      fireEvent.change(input, { target: { value: 'zzz' } });
    });
    await waitFor(() => expect(view.container.textContent).toContain('No matches'));
  });
});
