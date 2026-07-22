/**
 * AI Interpreter Service Tests
 * Requirements: 1.1, 1.2, 1.4, 5.2, 10.4, 10.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIInterpreterService } from '../index';
import type { LLMClient } from '../llm-client';
import { Answer } from '../../../types/blueprint';
import { Contract } from '../../../types/contract';
import { SAMPLE_COMPOSED, SAMPLE_TODO_CONTRACT } from '../../../test/llm-mocks';

// Mock the dependencies
vi.mock('../llm-client');

// Mock repository
const mockRepository = {
  queryUIElements: vi.fn(),
  queryOperations: vi.fn(),
  registerComponent: vi.fn(),
  getComponent: vi.fn(),
  updateComponent: vi.fn(),
  deleteComponent: vi.fn(),
  listComponents: vi.fn()
} as any;

// Mock LLM client injected into the service
const mockLLMClient = {
  sendMessage: vi.fn()
} as unknown as LLMClient;

describe('AIInterpreterService', () => {
  let service: AIInterpreterService;

  beforeEach(() => {
    service = new AIInterpreterService(mockRepository, mockLLMClient);
    vi.clearAllMocks();
  });

  describe('compose', () => {
    it('creates the contract and projected blueprint in one model call', async () => {
      const description = 'Create a todo list application with add, edit, and delete functionality';

      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: JSON.stringify(SAMPLE_COMPOSED)
      });

      const result = await service.compose(description);

      expect(mockLLMClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(result.contract.name).toBe('todo-list');
      expect(result.spec.goal).toBe('Create a todo list app');
      expect(result.spec.assumptions).toHaveLength(1);
      // Blueprint is projected from the composed result, not model-authored.
      expect(result.blueprint.goal).toBe('Create a todo list app');
      expect(result.blueprint.description).toBe(description);
      expect(result.blueprint.uiElements.map((e) => e.type)).toContain('list');
      expect(result.blueprint.operations.map((o) => o.name)).toContain('todos.add');

      // The prompt goes out as cached base block + create-mode block.
      const options = vi.mocked(mockLLMClient.sendMessage).mock.calls[0][1]!;
      expect(options.systemBlocks).toHaveLength(2);
      expect(options.systemBlocks![0].cache).toBe(true);
      expect(options.systemBlocks![0].text).toContain('Contract JSON');
      expect(options.systemBlocks![1].text).toContain('CREATE MODE');
    });

    it('should reject empty descriptions', async () => {
      await expect(service.compose('   ')).rejects.toThrow('Invalid description');
      expect(mockLLMClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should wrap LLM failures in a compose error', async () => {
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({ content: 'not json' });

      await expect(service.compose('Create an app')).rejects.toThrow('Failed to compose experience');
    });
  });

  describe('generateQuestions', () => {
    it('should generate questions from blueprint ambiguities', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: ['test'],
        uiElements: [],
        operations: [],
        ambiguities: [
          {
            id: 'ui_style',
            description: 'UI style preference',
            options: ['modern', 'classic'],
            question: 'What style do you prefer?'
          }
        ],
        userModifications: []
      };

      const expectedQuestions = [
        {
          id: 'ui_style',
          text: 'What style do you prefer?',
          type: 'choice' as const,
          options: ['modern', 'classic']
        }
      ];

      const result = await service.generateQuestions(blueprint);

      expect(result).toEqual(expectedQuestions);
    });

    it('should generate default questions when no ambiguities exist', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const result = await service.generateQuestions(blueprint);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].id).toBe('ui_style_preference');
    });
  });

  describe('refineBlueprint', () => {
    it('should refine blueprint with user answers', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [
          {
            id: 'ui_style',
            description: 'UI style preference',
            options: ['modern', 'classic'],
            question: 'What style do you prefer?'
          }
        ],
        userModifications: []
      };

      const answers = [
        {
          questionId: 'ui_style',
          value: 'modern'
        }
      ];

      const refinedBlueprint = {
        ...blueprint,
        ambiguities: [],
        requiredCapabilities: ['ui-style-modern'],
        userModifications: [
          {
            location: 'ambiguity.ui_style',
            originalValue: null,
            newValue: 'modern',
            timestamp: new Date(),
            preserved: true
          }
        ]
      };

      vi.spyOn(service['generator'], 'refineWithAnswers').mockReturnValue(refinedBlueprint);
      vi.spyOn(service['generator'], 'validateBlueprint').mockReturnValue({
        isValid: true,
        errors: [],
        warnings: []
      });

      const result = await service.refineBlueprint(blueprint, answers);

      expect(result).toEqual(refinedBlueprint);
      expect(service['generator'].refineWithAnswers).toHaveBeenCalledWith(blueprint, answers);
    });

    it('should reject invalid refined blueprints', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const answers: Answer[] = [];

      vi.spyOn(service['generator'], 'refineWithAnswers').mockReturnValue(blueprint);
      vi.spyOn(service['generator'], 'validateBlueprint').mockReturnValue({
        isValid: false,
        errors: [{ path: 'goal', message: 'Goal is required', code: 'MISSING_GOAL' }],
        warnings: []
      });

      await expect(service.refineBlueprint(blueprint, answers)).rejects.toThrow('Refined blueprint is invalid: Goal is required');
    });
  });

  describe('generateContract', () => {
    it('should generate contract from blueprint through the LLM', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      // Mock repository catalog lookup and the LLM contract response
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: JSON.stringify(SAMPLE_TODO_CONTRACT)
      });

      const contract = await service.generateContract(blueprint);

      expect(contract.name).toBe('todo-list');
      expect(contract.version).toBe('1.0.0');
      expect(contract.elements).toHaveLength(4);
      expect(contract.operations).toHaveLength(2);
      expect(contract.metadata.description).toBe(blueprint.goal);
      const options = vi.mocked(mockLLMClient.sendMessage).mock.calls[0][1]!;
      expect(options.systemBlocks![0].text).toContain('Contract JSON');
      expect(options.systemBlocks![1].text).toContain('BLUEPRINT MODE');
    });

    it('should apply user edits to generated contract', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const userEdits = {
        elementEdits: {},
        operationEdits: {},
        layoutEdits: { type: 'grid' as const, properties: { columns: 2 } },
        styleEdits: { theme: 'dark', customStyles: { color: 'blue' } }
      };

      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: JSON.stringify(SAMPLE_TODO_CONTRACT)
      });

      const contract = await service.generateContract(blueprint, userEdits);

      expect(contract.layout.type).toBe('grid');
      expect(contract.layout.properties.columns).toBe(2);
      expect(contract.styling.theme).toBe('dark');
      expect(contract.styling.customStyles?.color).toBe('blue');
    });

    it('should wrap LLM failures in a generation error', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({ content: 'not json' });

      await expect(service.generateContract(blueprint)).rejects.toThrow(
        'Failed to generate contract'
      );
    });
  });

  describe('preserveUserEdits', () => {
    it('should preserve user edits in contract', async () => {
      const contract: Contract = {
        name: 'test-contract',
        version: '1.0.0',
        elements: [
          {
            id: 'button1',
            type: 'button',
            properties: { text: 'Original Text' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex' as const, properties: {} },
        styling: { theme: 'light' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const userEdits = {
        elementEdits: {
          button1: { properties: { text: 'User Modified Text' } }
        },
        operationEdits: {},
        styleEdits: { theme: 'dark' }
      };

      const preservedContract = await service.preserveUserEdits(contract, userEdits);

      expect(preservedContract.elements[0].properties.text).toBe('User Modified Text');
      expect(preservedContract.styling.theme).toBe('dark');
    });
  });

  describe('regenerateWithPreservation', () => {
    it('should regenerate contract while preserving user edits', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const existingContract: Contract = {
        name: 'existing-contract',
        version: '1.0.0',
        elements: [],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'dark' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      // Mock repository catalog lookup and the LLM contract response
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: JSON.stringify(SAMPLE_TODO_CONTRACT)
      });

      const regeneratedContract = await service.regenerateWithPreservation(blueprint, existingContract, ['styling']);

      expect(regeneratedContract.name).toBe('todo-list'); // Freshly generated contract
      expect(regeneratedContract.version).toBe('1.0.0');
    });
  });

  describe('regenerateWithConflictDetection', () => {
    it('should detect conflicts when regenerating', async () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const existingContract: Contract = {
        name: 'existing-contract',
        version: '1.0.0',
        elements: [],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'dark' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      // Mock repository catalog lookup and the LLM contract response
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);
      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue({
        content: JSON.stringify(SAMPLE_TODO_CONTRACT)
      });

      const { contract, conflicts } = await service.regenerateWithConflictDetection(blueprint, existingContract, ['styling']);

      expect(contract).toBeDefined();
      expect(contract.name).toBe('todo-list');
      expect(conflicts).toBeInstanceOf(Array);
    });
  });
});