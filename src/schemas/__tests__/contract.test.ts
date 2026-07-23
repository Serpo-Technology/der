/**
 * Contract schema tests - the single validation authority for LLM output and
 * loaded contracts, plus legacy trigger normalization.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContractSchema, normalizeContract, validateContractObject } from '../contract';
import { Contract } from '../../types/contract';
import { SAMPLE_TODO_CONTRACT } from '../../test/llm-mocks';

function baseContract(overrides: Partial<Contract> = {}): Contract {
  return {
    name: 'test-contract',
    version: '1.0.0',
    elements: [
      {
        id: 'btn',
        type: 'button',
        properties: { text: 'Go' },
        dataBindings: [],
        eventBindings: []
      }
    ],
    operations: [
      {
        id: 'op-1',
        operationName: 'todos.add',
        executionType: 'builtin',
        inputs: [{ name: 'title', source: 'constant', sourceId: 'buy milk' }],
        outputs: [],
        triggers: []
      }
    ],
    layout: { type: 'flex', properties: {} },
    styling: { theme: 'default' },
    metadata: {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0'
    },
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSchema', () => {
  it('accepts the sample todo contract', () => {
    const result = ContractSchema.safeParse(SAMPLE_TODO_CONTRACT);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('todo-list');
      expect(result.data.elements).toHaveLength(4);
      expect(result.data.operations).toHaveLength(2);
    }
  });

  it('applies defaults for omitted collection fields', () => {
    const result = ContractSchema.safeParse({
      name: 'tiny',
      elements: [{ id: 'a', type: 'text' }]
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.operations).toEqual([]);
      expect(result.data.elements[0].properties).toEqual({});
      expect(result.data.elements[0].dataBindings).toEqual([]);
      expect(result.data.layout).toEqual({ type: 'flex', properties: {} });
      expect(result.data.styling.theme).toBe('default');
    }
  });

  it('rejects a contract without a name', () => {
    const { name: _name, ...nameless } = SAMPLE_TODO_CONTRACT;
    const result = ContractSchema.safeParse(nameless);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path[0] === 'name')).toBe(true);
    }
  });

  it('rejects a contract with no elements', () => {
    const result = ContractSchema.safeParse({ ...SAMPLE_TODO_CONTRACT, elements: [] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path[0] === 'elements')).toBe(true);
    }
  });
});

describe('validateContractObject', () => {
  it('returns valid for a well-formed contract', () => {
    const result = validateContractObject(
      baseContract({
        elements: [
          {
            id: 'btn',
            type: 'button',
            properties: { text: 'Go' },
            dataBindings: [],
            eventBindings: [{ event: 'click', operationId: 'op-1' }]
          }
        ]
      })
    );

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports schema failures with paths and codes', () => {
    const result = validateContractObject({ name: '', elements: [] });

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.path === 'name')).toBe(true);
    expect(result.errors.some(e => e.path === 'elements')).toBe(true);
  });

  it('flags event bindings that reference unknown operations', () => {
    const contract = baseContract({
      elements: [
        {
          id: 'btn',
          type: 'button',
          properties: {},
          dataBindings: [],
          eventBindings: [{ event: 'click', operationId: 'missing-op' }],
          children: [
            {
              id: 'nested',
              type: 'button',
              properties: {},
              dataBindings: [],
              eventBindings: [{ event: 'click', operationId: 'also-missing' }]
            }
          ]
        }
      ]
    });

    const result = validateContractObject(contract);

    expect(result.isValid).toBe(false);
    const unknown = result.errors.filter(e => e.code === 'UNKNOWN_OPERATION');
    expect(unknown).toHaveLength(2);
    expect(unknown[0].path).toBe('elements.0.eventBindings.0');
    expect(unknown[1].path).toBe('elements.0.children.0.eventBindings.0');
  });
});

describe('normalizeContract', () => {
  it('converts legacy event triggers into event bindings', () => {
    const contract = baseContract({
      operations: [
        {
          id: 'op-1',
          operationName: 'todos.add',
          executionType: 'builtin',
          inputs: [],
          outputs: [],
          triggers: [{ type: 'event', parameters: { elementId: 'btn', eventType: 'click' } }]
        }
      ]
    });

    const normalized = normalizeContract(contract);

    expect(normalized.elements[0].eventBindings).toEqual([
      { event: 'click', operationId: 'op-1' }
    ]);
    expect(normalized.operations[0].triggers).toEqual([]);
    // Pure: the input contract is untouched.
    expect(contract.operations[0].triggers).toHaveLength(1);
    expect(contract.elements[0].eventBindings).toEqual([]);
  });

  it('does not duplicate an existing equivalent event binding', () => {
    const contract = baseContract({
      elements: [
        {
          id: 'btn',
          type: 'button',
          properties: {},
          dataBindings: [],
          eventBindings: [{ event: 'click', operationId: 'op-1' }]
        }
      ],
      operations: [
        {
          id: 'op-1',
          operationName: 'todos.add',
          executionType: 'builtin',
          inputs: [],
          outputs: [],
          triggers: [{ type: 'event', parameters: { elementId: 'btn', eventType: 'click' } }]
        }
      ]
    });

    const normalized = normalizeContract(contract);

    expect(normalized.elements[0].eventBindings).toEqual([
      { event: 'click', operationId: 'op-1' }
    ]);
  });

  it('drops trigger kinds the runtime does not run', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contract = baseContract({
      operations: [
        {
          id: 'op-1',
          operationName: 'todos.add',
          executionType: 'builtin',
          inputs: [],
          outputs: [],
          triggers: [{ type: 'timer', parameters: { interval: 1000 } }]
        }
      ]
    });

    const normalized = normalizeContract(contract);

    expect(normalized.operations[0].triggers).toEqual([]);
    expect(normalized.elements[0].eventBindings).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timer'));
  });
});
