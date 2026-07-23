/**
 * The timer part: ticks drive operations while rendered, visibleWhen pauses
 * it, and state re-renders do not reset the pending interval.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { DynamicExperienceRenderer } from '../components/runtime/DynamicExperienceRenderer';
import type { Contract } from '../types/contract';

const contract = {
  name: 'tick-demo',
  version: '1.0.0',
  initialState: { running: true },
  elements: [
    {
      id: 'tick-timer',
      type: 'timer',
      properties: { seconds: 1 },
      dataBindings: [],
      eventBindings: [{ event: 'tick', operationId: 'op-tick' }],
      visibleWhen: { source: 'state', sourceId: 'running', operator: 'truthy' }
    },
    {
      id: 'elapsed-text',
      type: 'text',
      properties: {},
      dataBindings: [
        {
          property: 'content',
          source: 'state',
          sourceId: 'elapsed',
          transforms: [{ type: 'format', parameters: { template: 'Elapsed: {{value}}' } }]
        }
      ],
      eventBindings: []
    },
    {
      id: 'stop-btn',
      type: 'button',
      properties: { text: 'Stop' },
      dataBindings: [],
      eventBindings: [{ event: 'click', operationId: 'op-stop' }]
    }
  ],
  operations: [
    {
      id: 'op-tick',
      operationName: 'counter.add',
      inputs: [{ name: 'key', source: 'constant', sourceId: 'elapsed' }],
      outputs: [],
      triggers: []
    },
    {
      id: 'op-stop',
      operationName: 'state.set',
      inputs: [
        { name: 'key', source: 'constant', sourceId: 'running' },
        { name: 'value', source: 'constant', sourceId: 'false', value: false }
      ],
      outputs: [],
      triggers: []
    }
  ]
} as unknown as Contract;

describe('timer element', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks while visible and stops when the gate flips', async () => {
    vi.useFakeTimers();
    let lastData: Record<string, unknown> = {};
    const view = render(
      <DynamicExperienceRenderer
        contract={contract}
        experienceId="tick-demo"
        onStateChange={(state) => {
          lastData = state.data as Record<string, unknown>;
        }}
      />
    );

    // Let async state initialization finish so the gated timer mounts.
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(view.container.textContent).toContain('Elapsed: 3');

    // Stop: the gate hides the timer, which unmounts and stops the interval.
    await act(async () => {
      view.getByText('Stop').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    console.log('elapsed in state:', lastData.elapsed, 'running:', lastData.running);
    expect(view.container.textContent).toContain('Elapsed: 3');
  });
});

describe('textarea element', () => {
  it('renders with a label wrapper and auto-controls its value', async () => {
    const noteContract = {
      name: 'note-demo',
      version: '1.0.0',
      elements: [
        {
          id: 'note-in',
          type: 'textarea',
          properties: { label: 'Note', rows: 4, placeholder: 'Write...' },
          dataBindings: [],
          eventBindings: []
        },
        {
          id: 'echo',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'element_note-in' }],
          eventBindings: []
        }
      ],
      operations: []
    } as unknown as import('../types/contract').Contract;

    const { render: r, fireEvent, act: a } = await import('@testing-library/react');
    const view = r(
      <DynamicExperienceRenderer contract={noteContract} experienceId="note-demo" />
    );

    const area = view.container.querySelector('textarea')!;
    expect(area).toBeTruthy();
    expect(area.closest('label')?.className).toContain('der-field');
    expect(area.getAttribute('rows')).toBe('4');

    await a(async () => {
      fireEvent.change(area, { target: { value: 'hello world' } });
    });
    expect(view.container.textContent).toContain('hello world');
  });
});

describe('select options tolerance', () => {
  it('renders options bound as a JSON string constant', async () => {
    const contract = {
      name: 'select-demo',
      version: '1.0.0',
      elements: [
        {
          id: 'cat-in',
          type: 'select',
          properties: { label: 'Category' },
          dataBindings: [
            {
              property: 'options',
              source: 'constant',
              sourceId: '[{"value":"food","label":"Food"},{"value":"travel","label":"Travel"}]'
            }
          ],
          eventBindings: []
        }
      ],
      operations: []
    } as unknown as import('../types/contract').Contract;

    const { render: r } = await import('@testing-library/react');
    const view = r(
      <DynamicExperienceRenderer contract={contract} experienceId="select-demo" />
    );
    const options = view.container.querySelectorAll('option');
    expect([...options].map((o) => o.textContent)).toContain('Food');
    expect([...options].map((o) => o.textContent)).toContain('Travel');
  });
});

describe('select default commit', () => {
  it('commits the visible first option to element state on mount', async () => {
    const contract = {
      name: 'select-default-demo',
      version: '1.0.0',
      elements: [
        {
          id: 'cat-in',
          type: 'select',
          properties: {
            label: 'Category',
            options: [
              { value: 'food', label: 'Food' },
              { value: 'travel', label: 'Travel' }
            ]
          },
          dataBindings: [],
          eventBindings: []
        },
        {
          id: 'echo',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'element_cat-in' }],
          eventBindings: []
        }
      ],
      operations: []
    } as unknown as import('../types/contract').Contract;

    const { render: r, waitFor: w } = await import('@testing-library/react');
    const view = r(
      <DynamicExperienceRenderer contract={contract} experienceId="select-default-demo" />
    );
    await w(() => expect(view.container.textContent).toContain('food'));
  });
});
