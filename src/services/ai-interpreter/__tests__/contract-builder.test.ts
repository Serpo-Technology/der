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
      const messages = vi.mocked(mockLLMClient.sendMessage).mock.calls[0][0];
      const system = messages.find(m => m.role === 'system')!;
      expect(system.content).toContain('Contract JSON');
      expect(system.content).toContain('list.append');
      expect(system.content).toContain('TRANSFORMS');
      expect(system.content).toContain('NEVER write code');
      expect(system.content).not.toContain('todos.add');
      expect(system.content).toContain('REGISTERED CUSTOM OPERATIONS');
      expect(system.content).toContain('text.sentiment');
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

  describe('editContract', () => {
    it('prompts with the current contract in edit mode', async () => {
      mockLLMResponse(JSON.stringify(SAMPLE_TODO_CONTRACT));
      const current = { ...SAMPLE_TODO_CONTRACT, name: 'my-current-app' };

      await builder.editContract(current as any, 'add a clear-all button');

      const messages = vi.mocked(mockLLMClient.sendMessage).mock.calls[0][0];
      const system = messages.find(m => m.role === 'system')!;
      const user = messages.find(m => m.role === 'user')!;
      expect(system.content).toContain('EDIT MODE');
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
