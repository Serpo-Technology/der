/**
 * Tests for semantic contract validation against the part manifests. Covers
 * the repairable hard errors (unknown operations, inputs, outputs, and
 * transforms, missing inputs, invalid prefixes, unknown element references),
 * the cosmetic normalizations (defaulted knobs, seeded state keys,
 * deduplicated inputs), and the stricter LLM-facing schema.
 */

import { describe, it, expect } from 'vitest';
import {
  ComposedResponseSchema,
  ContractSchema,
  LlmContractSchema,
  checkAgainstManifests,
} from '../contract';
import type { ContractShape } from '../contract';
import { FRAGMENT_ELEMENTS } from '../../services/operations/registry';

function checkContract(raw: Record<string, unknown>) {
  const contract = JSON.parse(JSON.stringify(ContractSchema.parse(raw))) as ContractShape;
  const result = checkAgainstManifests(contract);
  return { contract, result };
}

function rawContract(overrides: Record<string, unknown> = {}) {
  return {
    name: 'manifest-check',
    elements: [
      { id: 'title-in', type: 'input' },
      { id: 'add-btn', type: 'button', properties: { text: 'Add' } }
    ],
    ...overrides
  };
}

describe('checkAgainstManifests hard errors', () => {
  it('flags an operation name that is neither builtin nor remote', () => {
    const { result } = checkContract(
      rawContract({
        operations: [{ id: 'op-x', operationName: 'wizardry.cast' }]
      })
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('UNKNOWN_OPERATION_NAME');
    expect(result.errors[0].path).toBe('operations.0');
    expect(result.errors[0].message).toContain('wizardry.cast');
  });

  it('accepts a non-builtin name backed by a remote endpoint', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-x',
            operationName: 'wizardry.cast',
            implementation: { type: 'remote', endpoint: 'https://api.example.com/cast' }
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
  });

  it('requires the key input on list.append', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-add',
            operationName: 'list.append',
            inputs: [{ name: 'item.title', source: 'ui-element', sourceId: 'title-in' }]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['MISSING_INPUT']);
    expect(result.errors[0].message).toContain('"key"');
  });

  it('requires at least one item field on list.append', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-add',
            operationName: 'list.append',
            inputs: [{ name: 'key', source: 'constant', sourceId: 'todos' }]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['MISSING_INPUT']);
    expect(result.errors[0].message).toContain('item.<field>');
  });

  it('rejects a prefixed input the operation does not accept', () => {
    const { contract, result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-add',
            operationName: 'list.append',
            inputs: [
              { name: 'key', source: 'constant', sourceId: 'todos' },
              { name: 'set.title', source: 'constant', sourceId: 'oops' },
              { name: 'item.title', source: 'ui-element', sourceId: 'title-in' }
            ]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['INVALID_PREFIX']);
    expect(result.errors[0].path).toBe('operations.0.inputs.1');
    expect(contract.operations[0].inputs.map((input) => input.name)).toEqual([
      'key',
      'item.title'
    ]);
  });

  it('flags input bindings that reference unknown elements', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-add',
            operationName: 'list.append',
            inputs: [
              { name: 'key', source: 'constant', sourceId: 'todos' },
              { name: 'item.title', source: 'ui-element', sourceId: 'ghost-in' }
            ]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_ELEMENT']);
    expect(result.errors[0].path).toBe('operations.0.inputs.1');
    expect(result.errors[0].message).toContain('ghost-in');
  });

  it('flags output bindings that target unknown elements', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-add',
            operationName: 'list.append',
            inputs: [
              { name: 'key', source: 'constant', sourceId: 'todos' },
              { name: 'item.title', source: 'ui-element', sourceId: 'title-in' }
            ],
            outputs: [{ name: 'reset', target: 'ui-element', targetId: 'ghost-out' }]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_ELEMENT']);
    expect(result.errors[0].path).toBe('operations.0.outputs.0');
    expect(result.errors[0].message).toContain('ghost-out');
  });

  it('states the fix when events are wired but the operations array is missing', () => {
    const { result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'add-btn',
            type: 'button',
            properties: { text: 'Add' },
            eventBindings: [{ event: 'click', operationId: 'op-add' }]
          },
          {
            id: 'del-btn',
            type: 'button',
            properties: { text: 'Delete' },
            eventBindings: [{ event: 'click', operationId: 'op-del' }]
          }
        ]
      })
    );

    expect(result.errors[0].code).toBe('MISSING_OPERATIONS');
    expect(result.errors[0].message).toContain('op-add, op-del');
    expect(result.errors[0].message).toContain('Add a top-level "operations" array');
  });

  it('flags event bindings that reference unknown operations', () => {
    const { result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'add-btn',
            type: 'button',
            properties: { text: 'Add' },
            eventBindings: [{ event: 'click', operationId: 'op-ghost' }]
          }
        ],
        operations: [
          {
            id: 'op-count',
            operationName: 'counter.add',
            inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_OPERATION']);
    expect(result.errors[0].path).toBe('elements.0.eventBindings.0');
    expect(result.errors[0].message).toContain('op-ghost');
  });
});

describe('checkAgainstManifests vocabulary and normalizations', () => {
  it('rejects inputs the operation does not declare, naming the accepted ones', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-count',
            operationName: 'counter.add',
            inputs: [
              { name: 'key', source: 'constant', sourceId: 'clicks' },
              { name: 'bogus', source: 'constant', sourceId: 'x' }
            ]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_INPUT']);
    expect(result.errors[0].message).toContain('bogus');
    expect(result.errors[0].message).toContain('it accepts:');
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects output bindings the operation does not declare', () => {
    const { result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-count',
            operationName: 'counter.add',
            inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }],
            outputs: [{ name: 'total', target: 'state', targetId: 'clicks' }]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_OUTPUT']);
    expect(result.errors[0].message).toContain('total');
    expect(result.errors[0].message).toContain('it provides:');
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects content pipelines that end in a list', () => {
    const { result } = checkContract(
      rawContract({
        initialState: { todos: [] },
        elements: [
          {
            id: 'count',
            type: 'text',
            dataBindings: [
              {
                property: 'content',
                source: 'state',
                sourceId: 'todos',
                transforms: [{ type: 'filterTruthy', parameters: { field: 'completed' } }]
              }
            ]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['PIPELINE_ENDS_IN_ARRAY']);
    expect(result.errors[0].message).toContain('count, sum, or pick');
  });

  it('accepts content pipelines that reduce to a scalar', () => {
    const { result } = checkContract(
      rawContract({
        initialState: { todos: [] },
        elements: [
          {
            id: 'count',
            type: 'text',
            dataBindings: [
              {
                property: 'content',
                source: 'state',
                sourceId: 'todos',
                transforms: [
                  { type: 'filterTruthy', parameters: { field: 'completed' } },
                  { type: 'count', parameters: {} }
                ]
              }
            ]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
  });

  it('rejects transform parameter references to unknown elements', () => {
    const { result } = checkContract(
      rawContract({
        initialState: { rows: [] },
        elements: [
          {
            id: 'rows-list',
            type: 'list',
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
                      value: { source: 'element', sourceId: 'ghost-search' }
                    }
                  }
                ]
              }
            ]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_ELEMENT']);
    expect(result.errors[0].message).toContain('ghost-search');
  });

  it('accepts a live search wiring and seeds state referenced by parameters', () => {
    const { contract, result } = checkContract(
      rawContract({
        elements: [
          { id: 'search-in', type: 'input', properties: { placeholder: 'Search' } },
          {
            id: 'rows-list',
            type: 'list',
            dataBindings: [
              {
                property: 'items',
                source: 'state',
                sourceId: 'rows',
                transforms: [
                  {
                    type: 'filterBy',
                    parameters: {
                      field: 'category',
                      value: { source: 'state', sourceId: 'active-category' }
                    }
                  }
                ]
              }
            ]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(contract.initialState?.['active-category']).toBeDefined();
  });

  it('rewrites center alignment on rows mixing labeled fields and buttons', () => {
    const { contract, result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'entry',
            type: 'container',
            properties: { direction: 'row', align: 'center', gap: '8' },
            children: [
              { id: 'task-in', type: 'input', properties: { label: 'New task' } },
              { id: 'add-btn', type: 'button', properties: { text: 'Add' } }
            ]
          },
          {
            id: 'texts-row',
            type: 'container',
            properties: { direction: 'row', align: 'center' },
            children: [
              { id: 'a', type: 'text', properties: { content: 'x' } },
              { id: 'b', type: 'text', properties: { content: 'y' } }
            ]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(contract.elements[0].properties.align).toBe('end');
    expect(result.warnings.some((w) => w.path === 'elements.0.properties.align')).toBe(true);
    // A centered row of plain texts is legitimate and stays untouched.
    expect(contract.elements[1].properties.align).toBe('center');
  });

  it('validates installed UI fragment parameters', () => {
    FRAGMENT_ELEMENTS['basics.entry_row'] = {
      name: 'basics.entry_row',
      description: 'x',
      params: [
        { name: 'label', type: 'string', required: true },
        { name: 'operationId', type: 'operationId', required: true }
      ],
      template: { id: '{{id}}-row', type: 'container' }
    };
    try {
      const { result } = checkContract(
        rawContract({
          elements: [
            {
              id: 'entry',
              type: 'basics.entry_row',
              properties: { operationId: 'op-ghost' }
            }
          ],
          operations: [
            {
              id: 'op-add',
              operationName: 'counter.add',
              inputs: [{ name: 'key', source: 'constant', sourceId: 'n' }]
            }
          ]
        })
      );

      expect(result.errors.map((e) => e.code).sort()).toEqual([
        'MISSING_FRAGMENT_PARAM',
        'UNKNOWN_OPERATION'
      ]);
    } finally {
      delete FRAGMENT_ELEMENTS['basics.entry_row'];
    }
  });

  it('accepts operation references into a fragment expansion', () => {
    FRAGMENT_ELEMENTS['basics.entry_row'] = {
      name: 'basics.entry_row',
      description: 'x',
      params: [
        { name: 'label', type: 'string', required: true },
        { name: 'operationId', type: 'operationId', required: true }
      ],
      template: {
        id: '{{id}}-row',
        type: 'container',
        children: [
          { id: '{{id}}-input', type: 'input', properties: { label: '{{label}}' } },
          {
            id: '{{id}}-btn',
            type: 'button',
            properties: { text: 'Add' },
            eventBindings: [{ event: 'click', operationId: '{{operationId}}' }]
          }
        ]
      }
    };
    try {
      const { result } = checkContract(
        rawContract({
          elements: [
            {
              id: 'task-entry',
              type: 'basics.entry_row',
              properties: { label: 'New task', operationId: 'op-add' }
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
              outputs: [{ name: 'reset', target: 'ui-element', targetId: 'task-entry-input' }]
            }
          ]
        })
      );

      expect(result.errors).toEqual([]);
    } finally {
      delete FRAGMENT_ELEMENTS['basics.entry_row'];
    }
  });

  it('normalizes unknown themes and accents with a warning', () => {
    const { contract, result } = checkContract(
      rawContract({ styling: { theme: 'neon', accent: 'plaid' } })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings.map((w) => w.path).sort()).toEqual([
      'styling.accent',
      'styling.theme'
    ]);
    expect(contract.styling?.theme).toBe('default');
    expect((contract.styling as { accent?: string }).accent).toBeUndefined();
  });

  it('accepts a known theme and accent silently', () => {
    const { contract, result } = checkContract(
      rawContract({ styling: { theme: 'terminal', accent: 'green' } })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(contract.styling?.theme).toBe('terminal');
    expect((contract.styling as { accent?: string }).accent).toBe('green');
  });

  it('resets an invalid knob value to the manifest default', () => {
    const { contract, result } = checkContract(
      rawContract({
        elements: [{ id: 'add-btn', type: 'button', properties: { text: 'Add', variant: 'sparkle' } }]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('elements.0.properties.variant');
    expect(contract.elements[0].properties.variant).toBe('default');
  });

  it('rejects unknown transforms in a pipeline', () => {
    const { result } = checkContract(
      rawContract({
        initialState: { todos: [] },
        elements: [
          {
            id: 'count-text',
            type: 'text',
            dataBindings: [
              {
                property: 'content',
                source: 'state',
                sourceId: 'todos',
                transforms: [
                  { type: 'sparkle', parameters: {} },
                  { type: 'count', parameters: {} }
                ]
              }
            ]
          }
        ]
      })
    );

    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_TRANSFORM']);
    expect(result.errors[0].message).toContain('sparkle');
    expect(result.warnings).toHaveLength(0);
  });

  it('silently seeds a state key read through an items binding with an empty array', () => {
    const { contract, result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'todo-list',
            type: 'list',
            dataBindings: [{ property: 'items', source: 'state', sourceId: 'rows' }]
          }
        ]
      })
    );

    // The empty-array seed is the normal omitted-seed case, so no warning.
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(contract.initialState?.rows).toEqual([]);
  });

  it('seeds other unwritten state reads with null', () => {
    const { contract, result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'greeting-text',
            type: 'text',
            dataBindings: [{ property: 'content', source: 'state', sourceId: 'greeting' }]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('initialState.greeting');
    expect(contract.initialState?.greeting).toBeNull();
  });

  it('does not seed keys an operation writes', () => {
    const { contract, result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'view-text',
            type: 'text',
            dataBindings: [{ property: 'content', source: 'state', sourceId: 'view' }]
          }
        ],
        operations: [
          {
            id: 'op-view',
            operationName: 'state.set',
            inputs: [
              { name: 'key', source: 'constant', sourceId: 'view' },
              { name: 'value', source: 'constant', sourceId: 'done' }
            ]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(contract.initialState).toBeUndefined();
  });

  it('keeps the last of duplicate input names', () => {
    const { contract, result } = checkContract(
      rawContract({
        operations: [
          {
            id: 'op-set',
            operationName: 'state.set',
            inputs: [
              { name: 'key', source: 'constant', sourceId: 'view' },
              { name: 'value', source: 'constant', sourceId: 'first' },
              { name: 'value', source: 'constant', sourceId: 'second' }
            ]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('Duplicate input');
    expect(contract.operations[0].inputs).toHaveLength(2);
    const valueInput = contract.operations[0].inputs.find((input) => input.name === 'value');
    expect(valueInput?.sourceId).toBe('second');
  });

  it('warns on item bindings outside a list template', () => {
    const { result } = checkContract(
      rawContract({
        elements: [
          {
            id: 'lonely-text',
            type: 'text',
            dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('outside a list template');
  });

  it('accepts item bindings inside a list template without warning', () => {
    const { result } = checkContract(
      rawContract({
        initialState: { todos: [] },
        elements: [
          {
            id: 'todo-list',
            type: 'list',
            dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
            children: [
              {
                id: 'row-title',
                type: 'text',
                dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }]
              }
            ]
          }
        ]
      })
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('passes a fully wired contract with no errors or warnings', () => {
    const { result } = checkContract({
      name: 'todo-app',
      initialState: { todos: [] },
      elements: [
        { id: 'title-in', type: 'input' },
        {
          id: 'add-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add' }]
        },
        {
          id: 'todo-list',
          type: 'list',
          properties: { emptyText: 'Nothing yet' },
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
          children: [
            {
              id: 'row-title',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }]
            }
          ]
        }
      ],
      operations: [
        {
          id: 'op-add',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'todos' },
            { name: 'item.title', source: 'ui-element', sourceId: 'title-in' }
          ],
          outputs: [{ name: 'reset', target: 'ui-element', targetId: 'title-in' }]
        }
      ]
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('ComposedResponseSchema', () => {
  it('parses a composed response and defaults a missing spec', () => {
    const parsed = ComposedResponseSchema.parse({ contract: rawContract() });

    expect(parsed.spec).toEqual({ goal: '', assumptions: [], openQuestions: [] });
    expect(parsed.contract.name).toBe('manifest-check');
    // Omitted optional fields materialize as schema defaults.
    expect(parsed.contract.operations).toEqual([]);
    expect(parsed.contract.elements[0].dataBindings).toBeDefined();
  });

  it('rejects code inside the nested contract exactly like LlmContractSchema', () => {
    const composed = {
      spec: { goal: 'x' },
      contract: rawContract({
        operations: [
          {
            id: 'op-code',
            operationName: 'custom.compute',
            implementation: {
              type: 'remote',
              endpoint: 'https://api.example.com/run',
              code: 'return 1;'
            }
          }
        ]
      })
    };

    const parsed = ComposedResponseSchema.safeParse(composed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.path.join('.').startsWith('contract.operations.0'))
      ).toBe(true);
    }
  });
});

describe('LlmContractSchema', () => {
  it('rejects an implementation carrying code while ContractSchema accepts it', () => {
    const raw = rawContract({
      operations: [
        {
          id: 'op-code',
          operationName: 'custom.compute',
          executionType: 'remote',
          implementation: {
            type: 'remote',
            endpoint: 'https://api.example.com/run',
            code: 'return 1;'
          }
        }
      ]
    });

    expect(ContractSchema.safeParse(raw).success).toBe(true);

    const llm = LlmContractSchema.safeParse(raw);
    expect(llm.success).toBe(false);
    if (!llm.success) {
      expect(
        llm.error.issues.some((issue) => issue.path.join('.').startsWith('operations.0'))
      ).toBe(true);
    }
  });

  it('rejects executionType local while ContractSchema accepts it', () => {
    const raw = rawContract({
      operations: [{ id: 'op-local', operationName: 'custom.compute', executionType: 'local' }]
    });

    expect(ContractSchema.safeParse(raw).success).toBe(true);

    const llm = LlmContractSchema.safeParse(raw);
    expect(llm.success).toBe(false);
    if (!llm.success) {
      expect(
        llm.error.issues.some((issue) => issue.path.join('.').includes('executionType'))
      ).toBe(true);
    }
  });
});
