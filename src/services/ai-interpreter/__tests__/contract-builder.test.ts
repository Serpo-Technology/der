/**
 * Contract Builder Tests
 *
 * The builder prompts the LLM with a catalog-constrained system prompt,
 * validates the response against ContractSchema (one repair round), and
 * post-processes ids, element types, and operation execution types.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContractBuilder } from '../contract-builder';
import { LLMClient } from '../llm-client';
import { ComponentRepository } from '../../../types/repository';
import { OperationManifest } from '../../../types/component';
import { Blueprint } from '../../../types/blueprint';
import { Contract } from '../../../types/contract';
import { SAMPLE_TODO_CONTRACT } from '../../../test/llm-mocks';

// Mock repository
const mockRepository = {
  queryUIElements: vi.fn(),
  queryOperations: vi.fn(),
  registerComponent: vi.fn(),
  getComponent: vi.fn(),
  updateComponent: vi.fn(),
  deleteComponent: vi.fn(),
  listComponents: vi.fn()
} as unknown as ComponentRepository;

// Mock LLM client
const mockLLMClient = {
  sendMessage: vi.fn()
} as unknown as LLMClient;

const blueprint: Blueprint = {
  description: 'A simple todo application',
  goal: 'Create a todo list application',
  requiredCapabilities: ['task-management'],
  uiElements: [
    { type: 'input', purpose: 'Add new tasks', capabilities: ['text-input'] },
    { type: 'button', purpose: 'Submit task', capabilities: ['click-action'] }
  ],
  operations: [
    {
      name: 'todos.add',
      purpose: 'Add a new task',
      inputs: ['title'],
      outputs: ['todos'],
      executionType: 'builtin'
    }
  ],
  ambiguities: [],
  userModifications: []
};

/** Minimal valid contract JSON the mocked LLM can return, with overrides. */
function contractJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'sample-app',
    version: '1.0.0',
    initialState: {},
    elements: [
      { id: 'title', type: 'text', properties: { content: 'Hi' }, dataBindings: [], eventBindings: [] }
    ],
    operations: [],
    layout: { type: 'flex', properties: {} },
    styling: { theme: 'default' },
    ...overrides
  });
}

function mockLLMResponse(content: string): void {
  vi.mocked(mockLLMClient.sendMessage).mockResolvedValueOnce({ content });
}

describe('ContractBuilder', () => {
  let builder: ContractBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new ContractBuilder(mockRepository, mockLLMClient);
    vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('composeFromDescription streaming', () => {
    it('feeds accumulated text to onPartial while the model streams', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      const full = JSON.stringify({ spec: { goal: 'x' }, contract: JSON.parse(contractJson()) });
      vi.mocked(mockLLMClient.sendMessage).mockImplementationOnce(async (_messages, options) => {
        const step = Math.ceil(full.length / 4);
        for (let i = 0; i < full.length; i += step) {
          options?.onChunk?.(full.slice(i, i + step));
        }
        return { content: full };
      });

      const partials: string[] = [];
      const { contract } = await builder.composeFromDescription('an app', (accumulated) =>
        partials.push(accumulated)
      );

      expect(contract.name).toBe('sample-app');
      expect(partials.length).toBeGreaterThan(0);
      // Accumulations only grow and the last one is the full response.
      for (let i = 1; i < partials.length; i++) {
        expect(partials[i].startsWith(partials[i - 1])).toBe(true);
      }
      expect(partials[partials.length - 1]).toBe(full);
    });
  });

  describe('local provider failure hint', () => {
    it('points at prompt truncation when a local model fails twice', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: '{"spec": {}, "contract": {"name": "x", "elements": ["not-an-object"]}}',
        provider: 'local',
        model: 'qwen2.5-coder:3b'
      });

      await expect(builder.composeFromDescription('a todo list')).rejects.toThrow(
        /OLLAMA_CONTEXT_LENGTH/
      );
    });
  });

  describe('editContract streaming progress', () => {
    it('reports accumulated text while the edit streams', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      const full = contractJson();
      vi.mocked(mockLLMClient.sendMessage).mockImplementationOnce(async (_messages, options) => {
        options?.onChunk?.(full.slice(0, 40));
        options?.onChunk?.(full.slice(40));
        return { content: full };
      });

      const sizes: number[] = [];
      await builder.editContract(
        JSON.parse(contractJson()),
        'rename the title',
        (accumulated) => sizes.push(accumulated.length)
      );

      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes[sizes.length - 1]).toBe(full.length);
    });
  });

  describe('repair rounds', () => {
    it('quotes the offending fragment in the repair message', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      const broken = JSON.stringify({
        spec: {},
        contract: {
          name: 'x',
          elements: [{ id: 'ok', type: 'text' }, { id: 'nameless-thing' }]
        }
      });
      const good = JSON.stringify({ spec: {}, contract: JSON.parse(contractJson()) });
      vi.mocked(mockLLMClient.sendMessage)
        .mockResolvedValueOnce({ content: broken })
        .mockResolvedValueOnce({ content: good });

      await builder.composeFromDescription('an app');

      const repairMessage = vi.mocked(mockLLMClient.sendMessage).mock.calls[1][0].at(-1)!;
      expect(repairMessage.content).toContain('nameless-thing');
      expect(repairMessage.content).toContain('the object there is:');
    });

    it('gives the local provider a second repair round', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      const broken = JSON.stringify({
        spec: {},
        contract: { name: 'x', elements: [{ id: 'nameless' }] }
      });
      const good = JSON.stringify({ spec: {}, contract: JSON.parse(contractJson()) });
      vi.mocked(mockLLMClient.sendMessage)
        .mockResolvedValueOnce({ content: broken, provider: 'local' })
        .mockResolvedValueOnce({ content: broken, provider: 'local' })
        .mockResolvedValueOnce({ content: good, provider: 'local' });

      const { contract } = await builder.composeFromDescription('an app');
      expect(contract.name).toBe('sample-app');
      expect(vi.mocked(mockLLMClient.sendMessage)).toHaveBeenCalledTimes(3);
    });

    it('stops after one repair round on non-local providers', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      const broken = JSON.stringify({
        spec: {},
        contract: { name: 'x', elements: [{ id: 'nameless' }] }
      });
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: broken,
        provider: 'anthropic'
      });

      await expect(builder.composeFromDescription('an app')).rejects.toThrow(
        /failed after a repair attempt/
      );
      expect(vi.mocked(mockLLMClient.sendMessage)).toHaveBeenCalledTimes(2);
    });
  });

  describe('generateFromBlueprint', () => {
    it('should generate a contract from the LLM response', async () => {
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.name).toBe('todo-list');
      expect(contract.version).toBe('1.0.0');
      expect(contract.elements).toHaveLength(4);
      expect(contract.operations).toHaveLength(2);
      expect(contract.operations.every(op => op.executionType === 'builtin')).toBe(true);
      expect(contract.layout.type).toBe('flex');
      expect(contract.styling.theme).toBe('default');
      expect(mockLLMClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockLLMClient.sendMessage).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ jsonMode: true })
      );
    });

    it('should prompt with the builtin catalog and repository operations', async () => {
      const customOp: OperationManifest = {
        id: 'sentiment-1',
        name: 'text.sentiment',
        version: '1.0.0',
        type: 'operation',
        description: 'Scores text sentiment',
        capabilities: ['text-analysis'],
        dependencies: [],
        schema: { type: 'object' },
        inputs: [{ name: 'text', type: 'string', required: true }],
        outputs: [{ name: 'score', type: 'number' }],
        executionType: 'local',
        implementation: { type: 'local', code: 'return { score: 1 };' }
      };
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([customOp]);
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));

      await builder.generateFromBlueprint(blueprint);

      expect(mockRepository.queryOperations).toHaveBeenCalledWith({});
      const [messages, options] = vi.mocked(mockLLMClient.sendMessage).mock.calls[0];
      const base = options!.systemBlocks![0];
      expect(base.cache).toBe(true);
      expect(base.text).toContain('Contract JSON');
      expect(base.text).toContain('list.append');
      expect(base.text).toContain('TRANSFORMS');
      expect(base.text).toContain('NEVER write code');
      expect(base.text).not.toContain('todos.add');
      expect(base.text).toContain('REGISTERED CUSTOM OPERATIONS');
      expect(base.text).toContain('text.sentiment');
      expect(options!.systemBlocks![1].text).toContain('BLUEPRINT MODE');
      const user = messages.find(m => m.role === 'user')!;
      expect(user.content).toContain(blueprint.goal);
    });

    it('should still generate when the repository is unavailable', async () => {
      vi.mocked(mockRepository.queryOperations).mockRejectedValue(new Error('no repository'));
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.name).toBe('todo-list');
    });

    it('should auto-fill metadata with the blueprint goal as description', async () => {
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.metadata.description).toBe(blueprint.goal);
      expect(contract.metadata.createdAt).toBeInstanceOf(Date);
      expect(contract.metadata.updatedAt).toBeInstanceOf(Date);
      expect(contract.metadata.version).toBe('1.0.0');
    });

    it('should recover with one repair round when the first response is malformed', async () => {
      mockLLMResponse('Sorry, here is prose without JSON');
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.name).toBe('todo-list');
      expect(mockLLMClient.sendMessage).toHaveBeenCalledTimes(2);
      const repairMessages = vi.mocked(mockLLMClient.sendMessage).mock.calls[1][0];
      expect(repairMessages[repairMessages.length - 2].role).toBe('assistant');
      const repairRequest = repairMessages[repairMessages.length - 1];
      expect(repairRequest.role).toBe('user');
      expect(repairRequest.content).toContain('previous response had problems');
    });

    it('should throw after a failed repair round', async () => {
      mockLLMResponse('not json');
      mockLLMResponse('still not json');

      await expect(builder.generateFromBlueprint(blueprint)).rejects.toThrow(
        'Contract generation failed after a repair attempt'
      );
      expect(mockLLMClient.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should rename duplicate ids with numeric suffixes', async () => {
      mockLLMResponse(
        contractJson({
          elements: [
            { id: 'dup', type: 'text', properties: {}, dataBindings: [], eventBindings: [] },
            { id: 'dup', type: 'text', properties: {}, dataBindings: [], eventBindings: [] }
          ]
        })
      );

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.elements.map(el => el.id)).toEqual(['dup', 'dup-2']);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should render unknown element types as containers and keep intrinsic tags', async () => {
      mockLLMResponse(
        contractJson({
          elements: [
            { id: 'weird', type: 'sparkle-widget', properties: {}, dataBindings: [], eventBindings: [] },
            { id: 'markup', type: 'DIV', properties: {}, dataBindings: [], eventBindings: [] },
            { id: 'plain', type: 'button', properties: {}, dataBindings: [], eventBindings: [] }
          ]
        })
      );

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.elements.map(el => el.type)).toEqual(['container', 'div', 'button']);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should resolve execution types for builtin and remote operations', async () => {
      mockLLMResponse(
        contractJson({
          elements: [
            {
              id: 'btn',
              type: 'button',
              properties: {},
              dataBindings: [],
              eventBindings: [{ event: 'click', operationId: 'op-builtin' }]
            }
          ],
          operations: [
            {
              id: 'op-builtin',
              operationName: 'todos.add',
              inputs: [{ name: 'title', source: 'constant', sourceId: 'hello' }],
              outputs: [],
              triggers: []
            },
            {
              id: 'op-remote',
              operationName: 'fetch.data',
              implementation: { type: 'remote', endpoint: 'https://api.example.com' },
              inputs: [],
              outputs: [],
              triggers: []
            }
          ]
        })
      );

      const contract = await builder.generateFromBlueprint(blueprint);

      const [builtinOp, remoteOp] = contract.operations;
      expect(builtinOp.executionType).toBe('builtin');
      expect(builtinOp.implementation).toBeUndefined();
      expect(remoteOp.executionType).toBe('remote');
      expect(remoteOp.implementation?.endpoint).toBe('https://api.example.com');
    });

    it('should reject model-authored code through the repair round', async () => {
      const withCode = contractJson({
        operations: [
          {
            id: 'op-code',
            operationName: 'custom.compute',
            implementation: { type: 'local', code: 'return {};' },
            inputs: [],
            outputs: [],
            triggers: []
          }
        ]
      });
      vi.mocked(mockLLMClient.sendMessage)
        .mockResolvedValueOnce({ content: withCode })
        .mockResolvedValueOnce({ content: JSON.stringify(SAMPLE_TODO_CONTRACT) });

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(vi.mocked(mockLLMClient.sendMessage)).toHaveBeenCalledTimes(2);
      const repairMessage = vi.mocked(mockLLMClient.sendMessage).mock.calls[1][0].at(-1)!;
      expect(repairMessage.role).toBe('user');
      expect(repairMessage.content).toContain('problems');
      expect(contract.operations.every(op => op.executionType !== 'local')).toBe(true);
    });

    it('should repair manifest violations such as unknown operations', async () => {
      const withGhost = contractJson({
        elements: [
          {
            id: 'btn',
            type: 'button',
            properties: {},
            dataBindings: [],
            eventBindings: [{ event: 'click', operationId: 'op-ghost' }]
          }
        ],
        operations: [
          { id: 'op-ghost', operationName: 'mystery.op', inputs: [], outputs: [], triggers: [] }
        ]
      });
      vi.mocked(mockLLMClient.sendMessage)
        .mockResolvedValueOnce({ content: withGhost })
        .mockResolvedValueOnce({ content: JSON.stringify(SAMPLE_TODO_CONTRACT) });

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(vi.mocked(mockLLMClient.sendMessage)).toHaveBeenCalledTimes(2);
      const repairMessage = vi.mocked(mockLLMClient.sendMessage).mock.calls[1][0].at(-1)!;
      expect(repairMessage.content).toContain('mystery.op');
      expect(contract.name).toBe('todo-list');
    });

    it('should convert legacy event triggers into event bindings', async () => {
      mockLLMResponse(
        contractJson({
          elements: [
            { id: 'btn', type: 'button', properties: {}, dataBindings: [], eventBindings: [] }
          ],
          operations: [
            {
              id: 'op-1',
              operationName: 'todos.add',
              executionType: 'builtin',
              inputs: [{ name: 'title', source: 'constant', sourceId: 'hello' }],
              outputs: [],
              triggers: [{ type: 'event', parameters: { elementId: 'btn', eventType: 'click' } }]
            }
          ]
        })
      );

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.elements[0].eventBindings).toEqual([{ event: 'click', operationId: 'op-1' }]);
      expect(contract.operations[0].triggers).toEqual([]);
    });
  });

  describe('composeFromDescription', () => {
    it('parses the composed response and post-processes the contract', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      mockLLMResponse(
        JSON.stringify({
          spec: {
            goal: 'Track daily todos',
            assumptions: ['Single shared list'],
            openQuestions: ['Support due dates?']
          },
          contract: JSON.parse(contractJson())
        })
      );

      const { contract, spec } = await builder.composeFromDescription('a todo app');

      expect(spec.goal).toBe('Track daily todos');
      expect(spec.assumptions).toEqual(['Single shared list']);
      expect(spec.openQuestions).toEqual(['Support due dates?']);
      expect(contract.name).toBe('sample-app');
      expect(contract.metadata?.description).toBe('Track daily todos');
    });

    it('defaults a missing spec instead of failing', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      mockLLMResponse(JSON.stringify({ contract: JSON.parse(contractJson()) }));

      const { spec } = await builder.composeFromDescription('a todo app');

      expect(spec).toEqual({ goal: '', assumptions: [], openQuestions: [] });
    });

    it('materializes emit-less contracts: omitted fields become runtime defaults', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      // Terse style: no initialState, no empty binding arrays, no
      // executionType, no triggers, no layout/styling/metadata.
      mockLLMResponse(
        JSON.stringify({
          spec: { goal: 'Count clicks' },
          contract: {
            name: 'clicker',
            version: '1.0.0',
            elements: [
              {
                id: 'count',
                type: 'text',
                dataBindings: [{ property: 'content', source: 'state', sourceId: 'clicks' }]
              },
              {
                id: 'btn',
                type: 'button',
                properties: { text: 'Click' },
                eventBindings: [{ event: 'click', operationId: 'op-inc' }]
              }
            ],
            operations: [
              {
                id: 'op-inc',
                operationName: 'counter.add',
                inputs: [
                  { name: 'key', source: 'constant', sourceId: 'clicks' },
                  { name: 'amount', source: 'constant', sourceId: '1' }
                ]
              }
            ]
          }
        })
      );

      const { contract } = await builder.composeFromDescription('a click counter');

      const button = contract.elements.find((el) => el.id === 'btn')!;
      expect(button.dataBindings).toEqual([]);
      const count = contract.elements.find((el) => el.id === 'count')!;
      expect(count.eventBindings).toEqual([]);
      expect(count.properties).toEqual({});

      const op = contract.operations[0];
      expect(op.executionType).toBe('builtin');
      expect(op.outputs).toEqual([]);
      expect(op.triggers).toEqual([]);

      // The default layout fills in so omission renders as the standard column.
      expect(contract.layout).toEqual({
        type: 'flex',
        properties: { flexDirection: 'column', gap: '12px', padding: '16px' }
      });
      expect(contract.styling).toEqual({ theme: 'default' });
      expect(contract.metadata?.description).toBe('Count clicks');
    });

    it('feeds contract problems back through the repair round', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      // First response wires a button to a missing operation; the repair
      // round must receive the problem and return a fixed composition.
      mockLLMResponse(
        JSON.stringify({
          spec: { goal: 'x' },
          contract: JSON.parse(
            contractJson({
              elements: [
                {
                  id: 'btn',
                  type: 'button',
                  properties: { text: 'Go' },
                  eventBindings: [{ event: 'click', operationId: 'op-missing' }]
                }
              ]
            })
          )
        })
      );
      mockLLMResponse(
        JSON.stringify({ spec: { goal: 'x' }, contract: JSON.parse(contractJson()) })
      );

      const { contract } = await builder.composeFromDescription('an app');

      expect(contract.name).toBe('sample-app');
      const calls = vi.mocked(mockLLMClient.sendMessage).mock.calls;
      expect(calls).toHaveLength(2);
      const repairUser = calls[1][0].filter((m) => m.role === 'user').pop()!;
      expect(repairUser.content).toContain('op-missing');
    });
  });

  describe('editContract', () => {
    it('prompts with the current contract in edit mode', async () => {
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));
      const current = { ...SAMPLE_TODO_CONTRACT, name: 'my-current-app' };

      await builder.editContract(current as any, 'add a clear-all button');

      const [messages, options] = vi.mocked(mockLLMClient.sendMessage).mock.calls[0];
      expect(options!.systemBlocks![0].cache).toBe(true);
      expect(options!.systemBlocks![1].text).toContain('EDIT MODE');
      const user = messages.find(m => m.role === 'user')!;
      expect(user.content).toContain('my-current-app');
      expect(user.content).toContain('add a clear-all button');
    });

    it('repairs an edit that reuses an id for a different kind of part', async () => {
      const mutated = JSON.parse(JSON.stringify(SAMPLE_TODO_CONTRACT));
      // The edit response hijacks an existing element id with a new type.
      mutated.elements[0] = { ...mutated.elements[0], type: 'button', properties: { text: 'x' } };
      vi.mocked(mockLLMClient.sendMessage)
        .mockResolvedValueOnce({ content: JSON.stringify(mutated) })
        .mockResolvedValueOnce({ content: JSON.stringify(SAMPLE_TODO_CONTRACT) });

      const contract = await builder.editContract(SAMPLE_TODO_CONTRACT as any, 'restyle the title');

      expect(vi.mocked(mockLLMClient.sendMessage)).toHaveBeenCalledTimes(2);
      const repairMessage = vi.mocked(mockLLMClient.sendMessage).mock.calls[1][0].at(-1)!;
      expect(repairMessage.content).toContain('must keep it');
      expect(contract.elements[0].type).toBe(SAMPLE_TODO_CONTRACT.elements[0].type);
    });

    it('warns about parts the edit removed', async () => {
      const trimmed = JSON.parse(JSON.stringify(SAMPLE_TODO_CONTRACT));
      const removed = trimmed.elements.pop();
      mockLLMResponse(JSON.stringify(trimmed));

      await builder.editContract(SAMPLE_TODO_CONTRACT as any, 'remove the list');

      const warnings = builder.getLastWarnings();
      expect(
        warnings.some(w => w.code === 'EDIT_REMOVED_PART' && w.message.includes(removed.id))
      ).toBe(true);
    });
  });

  describe('validateContract', () => {
    const validContract: Contract = {
      name: 'test-contract',
      version: '1.0.0',
      elements: [
        {
          id: 'element1',
          type: 'input',
          properties: {},
          dataBindings: [],
          eventBindings: [],
          children: []
        }
      ],
      operations: [
        {
          id: 'operation1',
          operationName: 'state.set',
          executionType: 'builtin' as const,
          inputs: [
            { name: 'key', source: 'constant' as const, sourceId: 'view' },
            { name: 'value', source: 'constant' as const, sourceId: 'list' }
          ],
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
      }
    };

    it('should validate complete contract successfully', () => {
      const result = builder.validateContract(validContract);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept a contract model exposing toObject', () => {
      const model = { toObject: () => validContract };

      const result = builder.validateContract(model);

      expect(result.isValid).toBe(true);
    });

    it('should detect missing required fields', () => {
      const result = builder.validateContract({
        name: '',
        elements: [],
        operations: []
      });

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.path === 'name')).toBe(true);
      expect(result.errors.some(e => e.path === 'elements')).toBe(true);
    });

    it('should detect event bindings that reference unknown operations', () => {
      const contract: Contract = {
        ...validContract,
        elements: [
          {
            id: 'element1',
            type: 'button',
            properties: {},
            dataBindings: [],
            eventBindings: [{ event: 'click', operationId: 'nonexistent-operation' }],
            children: []
          }
        ]
      };

      const result = builder.validateContract(contract);

      expect(result.isValid).toBe(false);
      const unknown = result.errors.filter(e => e.code === 'UNKNOWN_OPERATION');
      expect(unknown).toHaveLength(1);
      expect(unknown[0].message).toContain('nonexistent-operation');
    });
  });
});
