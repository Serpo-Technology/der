/**
 * Composed UI fragment expansion: parameter substitution with type
 * preservation, instance-scoped ids, visibility passthrough, and an
 * end-to-end render of a wired entry row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { expandUiFragment } from '../ui-fragments';
import { FRAGMENT_ELEMENTS, UiFragmentDef } from '../../operations/registry';
import { DynamicExperienceRenderer } from '../../../components/runtime/DynamicExperienceRenderer';
import type { Contract, UIElement } from '../../../types/contract';

const ENTRY_ROW: UiFragmentDef = {
  name: 'basics.entry_row',
  description: 'entry row',
  params: [
    { name: 'label', type: 'string', required: true },
    { name: 'placeholder', type: 'string', default: '' },
    { name: 'buttonText', type: 'string', default: 'Add' },
    { name: 'operationId', type: 'operationId', required: true }
  ],
  template: {
    id: '{{id}}-row',
    type: 'container',
    properties: { direction: 'row', gap: '8', align: 'end' },
    children: [
      { id: '{{id}}-input', type: 'input', properties: { label: '{{label}}', placeholder: '{{placeholder}}' } },
      {
        id: '{{id}}-btn',
        type: 'button',
        properties: { text: '{{buttonText}}', variant: 'primary' },
        eventBindings: [{ event: 'click', operationId: '{{operationId}}' }]
      }
    ]
  }
};

describe('expandUiFragment', () => {
  it('substitutes params, scopes ids, and applies defaults', () => {
    const instance = {
      id: 'task-entry',
      type: 'basics.entry_row',
      properties: { label: 'New task', operationId: 'op-add' },
      dataBindings: [],
      eventBindings: [],
      visibleWhen: { source: 'state', sourceId: 'editing', operator: 'truthy' }
    } as unknown as UIElement;

    const expanded = expandUiFragment(instance, ENTRY_ROW);
    expect(expanded.id).toBe('task-entry-row');
    expect(expanded.visibleWhen).toEqual(instance.visibleWhen);
    const [input, button] = expanded.children!;
    expect(input.id).toBe('task-entry-input');
    expect(input.properties.label).toBe('New task');
    expect(button.properties.text).toBe('Add');
    expect(button.eventBindings[0].operationId).toBe('op-add');
  });

  it('preserves value types for exact placeholders', () => {
    const def: UiFragmentDef = {
      name: 'basics.gauge',
      description: 'x',
      params: [{ name: 'max', type: 'number', default: 100 }],
      template: { id: '{{id}}-g', type: 'progress', properties: { max: '{{max}}' } }
    };
    const expanded = expandUiFragment(
      { id: 'g1', type: 'basics.gauge', properties: {}, dataBindings: [], eventBindings: [] } as unknown as UIElement,
      def
    );
    expect(expanded.properties.max).toBe(100);
  });
});

describe('fragment instances render end to end', () => {
  beforeEach(() => {
    FRAGMENT_ELEMENTS['basics.entry_row'] = ENTRY_ROW;
  });
  afterEach(() => {
    delete FRAGMENT_ELEMENTS['basics.entry_row'];
  });

  it('renders the expanded row and runs the wired operation', async () => {
    const contract = {
      name: 'frag-demo',
      version: '1.0.0',
      elements: [
        {
          id: 'task-entry',
          type: 'basics.entry_row',
          properties: { label: 'New task', operationId: 'op-add' },
          dataBindings: [],
          eventBindings: []
        },
        {
          id: 'count',
          type: 'text',
          properties: {},
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'tasks',
              transforms: [
                { type: 'count', parameters: {} },
                { type: 'format', parameters: { template: '{{value}} tasks' } }
              ]
            }
          ],
          eventBindings: []
        }
      ],
      operations: [
        {
          id: 'op-add',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'tasks' },
            { name: 'item.title', source: 'ui-element', sourceId: 'task-entry-input' }
          ],
          outputs: [],
          triggers: []
        }
      ]
    } as unknown as Contract;

    const view = render(
      <DynamicExperienceRenderer contract={contract} experienceId="frag-demo" />
    );

    const input = await waitFor(() => {
      const el = view.container.querySelector('input');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(input.closest('label')?.textContent).toContain('New task');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'write tests' } });
    });
    await act(async () => {
      fireEvent.click(view.getByText('Add'));
    });

    await waitFor(() => expect(view.container.textContent).toContain('1 tasks'));
  });
});
