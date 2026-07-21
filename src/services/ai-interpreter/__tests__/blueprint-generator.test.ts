/**
 * Blueprint Generator Tests
 * Requirements: 1.1, 1.2, 1.4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BlueprintGenerator } from '../blueprint-generator';
import { ParsedIntent, Answer } from '../../../types/blueprint';

describe('BlueprintGenerator', () => {
  let generator: BlueprintGenerator;

  beforeEach(() => {
    generator = new BlueprintGenerator();
  });

  describe('generateFromIntent', () => {
    it('should generate blueprint from parsed intent', () => {
      const intent: ParsedIntent = {
        goal: 'Create a todo list application',
        requiredCapabilities: ['task-management', 'data-persistence'],
        uiElements: [
          {
            type: 'input',
            purpose: 'Add new tasks',
            capabilities: ['text-input']
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
        ambiguities: [
          {
            id: 'ui_style',
            description: 'UI style preference',
            options: ['modern', 'classic'],
            question: 'What style do you prefer?'
          }
        ]
      };

      const blueprint = generator.generateFromIntent(intent);

      expect(blueprint.goal).toBe(intent.goal);
      expect(blueprint.requiredCapabilities).toEqual(intent.requiredCapabilities);
      expect(blueprint.uiElements).toEqual(intent.uiElements);
      expect(blueprint.operations).toEqual(intent.operations);
      expect(blueprint.ambiguities).toEqual(intent.ambiguities);
      expect(blueprint.userModifications).toEqual([]);
      expect(blueprint.description).toContain('Create a todo list application');
    });

    it('should remove duplicate capabilities', () => {
      const intent: ParsedIntent = {
        goal: 'Test app',
        requiredCapabilities: ['capability1', 'capability2', 'capability1'],
        uiElements: [],
        operations: [],
        ambiguities: []
      };

      const blueprint = generator.generateFromIntent(intent);

      expect(blueprint.requiredCapabilities).toEqual(['capability1', 'capability2']);
    });

    it('should generate comprehensive description', () => {
      const intent: ParsedIntent = {
        goal: 'Create a data dashboard',
        requiredCapabilities: ['data-visualization', 'real-time-updates'],
        uiElements: [
          { type: 'chart', purpose: 'Display metrics', capabilities: ['visualization'] }
        ],
        operations: [
          { name: 'fetchData', purpose: 'Get data', inputs: [], outputs: ['data'], executionType: 'remote' }
        ],
        ambiguities: []
      };

      const blueprint = generator.generateFromIntent(intent);

      expect(blueprint.description).toContain('Create a data dashboard');
      expect(blueprint.description).toContain('chart');
      expect(blueprint.description).toContain('fetchData');
      expect(blueprint.description).toContain('data-visualization');
    });
  });

  describe('refineWithAnswers', () => {
    it('should refine blueprint with user answers', () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create test app',
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

      const answers: Answer[] = [
        {
          questionId: 'ui_style',
          value: 'modern'
        }
      ];

      const refined = generator.refineWithAnswers(blueprint, answers);

      expect(refined.ambiguities).toHaveLength(0);
      expect(refined.requiredCapabilities).toContain('ui-style-modern');
      expect(refined.userModifications).toHaveLength(1);
      expect(refined.userModifications![0].location).toBe('ambiguity.ui_style');
    });

    it('should preserve existing user modifications', () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create test app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [
          {
            id: 'new_ambiguity',
            description: 'New question',
            options: ['yes', 'no'],
            question: 'Do you want this?'
          }
        ],
        userModifications: [
          {
            location: 'previous.modification',
            originalValue: 'old',
            newValue: 'new',
            timestamp: new Date('2023-01-01'),
            preserved: true
          }
        ]
      };

      const answers: Answer[] = [
        {
          questionId: 'new_ambiguity',
          value: 'yes'
        }
      ];

      const refined = generator.refineWithAnswers(blueprint, answers);

      expect(refined.userModifications).toHaveLength(2);
      expect(refined.userModifications![0].location).toBe('previous.modification');
      expect(refined.userModifications![1].location).toBe('ambiguity.new_ambiguity');
    });
  });

  describe('validateBlueprint', () => {
    it('should validate complete blueprint successfully', () => {
      const blueprint = {
        description: 'A complete todo application',
        goal: 'Create a todo list application',
        requiredCapabilities: ['task-management'],
        uiElements: [
          {
            type: 'input',
            purpose: 'Add tasks',
            capabilities: ['text-input']
          }
        ],
        operations: [
          {
            name: 'addTask',
            purpose: 'Add a new task',
            inputs: ['text'],
            outputs: ['taskId'],
            executionType: 'local' as const
          }
        ],
        ambiguities: [],
        userModifications: []
      };

      const result = generator.validateBlueprint(blueprint);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const blueprint = {
        description: '',
        goal: '',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const result = generator.validateBlueprint(blueprint);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_GOAL')).toBe(true);
      expect(result.errors.some(e => e.code === 'MISSING_DESCRIPTION')).toBe(true);
    });

    it('should detect invalid UI elements', () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [
          {
            type: '',
            purpose: '',
            capabilities: []
          }
        ],
        operations: [],
        ambiguities: [],
        userModifications: []
      };

      const result = generator.validateBlueprint(blueprint);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_UI_ELEMENT_TYPE')).toBe(true);
      expect(result.warnings.some(w => w.code === 'MISSING_UI_ELEMENT_PURPOSE')).toBe(true);
    });

    it('should detect invalid operations', () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [
          {
            name: '',
            purpose: '',
            inputs: [],
            outputs: [],
            executionType: 'invalid' as any
          }
        ],
        ambiguities: [],
        userModifications: []
      };

      const result = generator.validateBlueprint(blueprint);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_OPERATION_NAME')).toBe(true);
      expect(result.errors.some(e => e.code === 'INVALID_EXECUTION_TYPE')).toBe(true);
      expect(result.warnings.some(w => w.code === 'MISSING_OPERATION_PURPOSE')).toBe(true);
    });

    it('should warn about unresolved ambiguities', () => {
      const blueprint = {
        description: 'Test app',
        goal: 'Create app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [
          {
            id: 'test',
            description: 'Test ambiguity',
            options: [],
            question: 'Test question?'
          }
        ],
        userModifications: []
      };

      const result = generator.validateBlueprint(blueprint);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.code === 'UNRESOLVED_AMBIGUITIES')).toBe(true);
    });
  });
});