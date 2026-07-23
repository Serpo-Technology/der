/**
 * Per-row computed fields end to end: a deriveField step on a list's items
 * binding makes the computed value readable inside the row template's item
 * scope, and an aggregate pipeline totals the true per-row products.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { DynamicExperienceRenderer } from '../DynamicExperienceRenderer';
import type { Contract } from '../../../types/contract';

describe('deriveField in the renderer', () => {
  it('rows read their own computed value and the total is the per-row sum', async () => {
    const derive = {
      type: 'deriveField',
      parameters: { field: 'value', expression: 'qty * price' }
    };
    const contract = {
      name: 'inventory',
      version: '1.0.0',
      initialState: {
        stock: [
          { id: '1', name: 'widget', qty: 2, price: 10 },
          { id: '2', name: 'gadget', qty: 3, price: 5 }
        ]
      },
      elements: [
        {
          id: 'rows',
          type: 'list',
          properties: {},
          dataBindings: [
            { property: 'items', source: 'state', sourceId: 'stock', transforms: [derive] }
          ],
          eventBindings: [],
          children: [
            {
              id: 'r-name',
              type: 'text',
              properties: {},
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'name' }],
              eventBindings: []
            },
            {
              id: 'r-value',
              type: 'text',
              properties: {},
              dataBindings: [
                {
                  property: 'content',
                  source: 'item',
                  sourceId: 'value',
                  transforms: [
                    { type: 'format', parameters: { template: 'worth {{value}}' } }
                  ]
                }
              ],
              eventBindings: []
            }
          ]
        },
        {
          id: 'total',
          type: 'text',
          properties: {},
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'stock',
              transforms: [
                derive,
                { type: 'sum', parameters: { field: 'value' } },
                { type: 'format', parameters: { template: 'Total: {{value}}' } }
              ]
            }
          ],
          eventBindings: []
        }
      ],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: { createdAt: new Date(), updatedAt: new Date(), version: '1.0.0' }
    } as unknown as Contract;

    const { getByText, queryByText } = render(
      <DynamicExperienceRenderer contract={contract} experienceId="derive-test" />
    );
    await act(async () => {});

    expect(getByText('worth 20')).toBeTruthy();
    expect(getByText('worth 15')).toBeTruthy();
    expect(getByText('Total: 35')).toBeTruthy();
    // The wrong shape, sum(qty) * avg(price), would show 37.5.
    expect(queryByText(/37\.5/)).toBeNull();
  });
});
