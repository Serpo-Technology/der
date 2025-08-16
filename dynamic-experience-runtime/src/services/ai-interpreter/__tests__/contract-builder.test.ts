/**
 * Contract Builder Tests
 * Requirements: 2.1, 2.2, 2.5, 2.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContractBuilder } from '../contract-builder';
import { ComponentRepository } from '../../../types/repository';
import { UIElementManifest, OperationManifest } from '../../../types/component';
import { Blueprint } from '../../../types/blueprint';
import { Contract } from '../../../types/contract';

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

describe('ContractBuilder', () => {
  let builder: ContractBuilder;

  beforeEach(() => {
    builder = new ContractBuilder(mockRepository);
    vi.clearAllMocks();
  });

  describe('generateFromBlueprint', () => {
    it('should generate contract from blueprint with UI elements and operations', async () => {
      const blueprint: Blueprint = {
        description: 'A simple todo application',
        goal: 'Create a todo list application',
        requiredCapabilities: ['task-management'],
        uiElements: [
          {
            type: 'input',
            purpose: 'Add new tasks',
            capabilities: ['text-input']
          },
          {
            type: 'button',
            purpose: 'Submit task',
            capabilities: ['click-action']
          }
        ],
        operations: [
          {
            name: 'addTask',
            purpose: 'Add a new task',
            inputs: ['taskText'],
            outputs: ['taskId'],
            executionType: 'local'
          }
        ],
        ambiguities: [],
        userModifications: []
      };

      // Mock repository responses
      const mockUIManifest: UIElementManifest = {
        id: 'input-1',
        name: 'input',
        version: '1.0.0',
        type: 'ui-element',
        description: 'Text input element',
        capabilities: ['text-input'],
        dependencies: [],
        schema: { type: 'object', properties: { placeholder: { type: 'string' } } },
        inputs: [],
        outputs: [{ name: 'value', type: 'string' }],
        renderFunction: 'renderInput',
        styleSchema: { type: 'object' }
      };

      const mockButtonManifest: UIElementManifest = {
        id: 'button-1',
        name: 'button',
        version: '1.0.0',
        type: 'ui-element',
        description: 'Button element',
        capabilities: ['click-action'],
        dependencies: [],
        schema: { type: 'object', properties: { text: { type: 'string' } } },
        inputs: [],
        outputs: [{ name: 'click', type: 'event' }],
        renderFunction: 'renderButton',
        styleSchema: { type: 'object' }
      };

      const mockOperationManifest: OperationManifest = {
        id: 'add-task-1',
        name: 'addTask',
        version: '1.0.0',
        type: 'operation',
        description: 'Add task operation',
        capabilities: ['task-management'],
        dependencies: [],
        schema: { type: 'object' },
        inputs: [{ name: 'taskText', type: 'string', required: true }],
        outputs: [{ name: 'taskId', type: 'string' }],
        executionType: 'local',
        implementation: { type: 'local', code: 'function addTask() {}' }
      };

      vi.mocked(mockRepository.queryUIElements)
        .mockResolvedValueOnce([mockUIManifest])
        .mockResolvedValueOnce([mockButtonManifest]);

      vi.mocked(mockRepository.queryOperations)
        .mockResolvedValueOnce([mockOperationManifest]);

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.name).toBe('create-a-todo');
      expect(contract.version).toBe('1.0.0');
      expect(contract.elements).toHaveLength(2);
      expect(contract.operations).toHaveLength(1);
      expect(contract.layout.type).toBe('flex');
      expect(contract.styling.theme).toBe('default');
      expect(contract.metadata.description).toBe(blueprint.description);
    });

    it('should create fallback elements when no manifests found', async () => {
      const blueprint: Blueprint = {
        description: 'Test app',
        goal: 'Create test app',
        requiredCapabilities: [],
        uiElements: [
          {
            type: 'unknown-element',
            purpose: 'Test element',
            capabilities: []
          }
        ],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      // Mock empty repository responses
      vi.mocked(mockRepository.queryUIElements).mockResolvedValue([]);

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.elements).toHaveLength(1);
      expect(contract.elements[0].type).toBe('unknown-element');
      expect(contract.elements[0].properties.placeholder).toBe(true);
    });

    it('should create placeholder operations when no manifests found', async () => {
      const blueprint: Blueprint = {
        description: 'Test app',
        goal: 'Create test app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [
          {
            name: 'unknownOperation',
            purpose: 'Test operation',
            inputs: ['input1'],
            outputs: ['output1'],
            executionType: 'local'
          }
        ],
        ambiguities: [],
        userModifications: []
      };

      // Mock empty repository responses
      vi.mocked(mockRepository.queryOperations).mockResolvedValue([]);

      const contract = await builder.generateFromBlueprint(blueprint);

      expect(contract.operations).toHaveLength(1);
      expect(contract.operations[0].operationName).toBe('unknownOperation');
    });

    it('should generate appropriate styling based on capabilities', async () => {
      const modernBlueprint: Blueprint = {
        description: 'Modern app',
        goal: 'Create modern app',
        requiredCapabilities: ['modern-ui', 'minimal-design'],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const darkBlueprint: Blueprint = {
        description: 'Dark app',
        goal: 'Create dark app',
        requiredCapabilities: ['dark-theme'],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const modernContract = await builder.generateFromBlueprint(modernBlueprint);
      const darkContract = await builder.generateFromBlueprint(darkBlueprint);

      expect(modernContract.styling.theme).toBe('modern');
      expect(darkContract.styling.theme).toBe('dark');
    });
  });

  describe('validateContract', () => {
    it('should validate complete contract successfully', () => {
      const contract: Contract = {
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
            operationName: 'testOp',
            inputs: [],
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

      const result = builder.validateContract(contract);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const contract: Contract = {
        name: '',
        version: '',
        elements: [],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'default' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const result = builder.validateContract(contract);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_NAME')).toBe(true);
      expect(result.errors.some(e => e.code === 'MISSING_VERSION')).toBe(true);
      expect(result.warnings.some(w => w.code === 'NO_ELEMENTS')).toBe(true);
    });

    it('should detect invalid element properties', () => {
      const contract: Contract = {
        name: 'test-contract',
        version: '1.0.0',
        elements: [
          {
            id: '',
            type: '',
            properties: {},
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'default' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const result = builder.validateContract(contract);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_ELEMENT_ID')).toBe(true);
      expect(result.errors.some(e => e.code === 'MISSING_ELEMENT_TYPE')).toBe(true);
    });

    it('should detect invalid binding references', () => {
      const contract: Contract = {
        name: 'test-contract',
        version: '1.0.0',
        elements: [
          {
            id: 'element1',
            type: 'input',
            properties: {},
            dataBindings: [
              {
                property: 'value',
                source: 'operation' as const,
                sourceId: 'nonexistent-operation'
              }
            ],
            eventBindings: [
              {
                event: 'click',
                operationId: 'nonexistent-operation'
              }
            ],
            children: []
          }
        ],
        operations: [
          {
            id: 'operation1',
            operationName: 'testOp',
            inputs: [
              {
                name: 'input1',
                source: 'ui-element' as const,
                sourceId: 'nonexistent-element'
              }
            ],
            outputs: [
              {
                name: 'output1',
                target: 'ui-element' as const,
                targetId: 'nonexistent-element'
              }
            ],
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

      const result = builder.validateContract(contract);

      expect(result.isValid).toBe(false);
      expect(result.errors.filter(e => e.code === 'INVALID_BINDING_REFERENCE')).toHaveLength(4);
    });
  });
});