/**
 * Blueprint Generator Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BlueprintGenerator } from '../blueprint-generator';
import { Answer } from '../../../types/blueprint';
import { SAMPLE_TODO_CONTRACT } from '../../../test/llm-mocks';

describe('BlueprintGenerator', () => {
  let generator: BlueprintGenerator;

  beforeEach(() => {
    generator = new BlueprintGenerator();
  });

  describe('deriveFromComposition', () => {
    const spec = {
      goal: 'Create a todo list app',
      assumptions: ['Todos are local'],
      openQuestions: ['Should completed todos auto-archive?']
    };

    it('projects elements, operations, and goal from the composed result', () => {
      const blueprint = generator.deriveFromComposition(
        spec,
        SAMPLE_TODO_CONTRACT as any,
        'a todo app'
      );

      expect(blueprint.goal).toBe('Create a todo list app');
      expect(blueprint.description).toBe('a todo app');
      // Nested list children are included in the projection.
      expect(blueprint.uiElements.map((e) => e.type)).toEqual([
        'text',
        'input',
        'button',
        'list',
        'text',
        'button'
      ]);
      expect(blueprint.uiElements[0].purpose).toBe('My Todos');
      expect(blueprint.operations.map((o) => o.name)).toEqual(['todos.add', 'todos.toggle']);
      expect(blueprint.operations[0].inputs).toEqual(['title']);
      expect(blueprint.operations[0].outputs).toEqual(['reset']);
      expect(blueprint.requiredCapabilities).toContain('list');
      expect(blueprint.requiredCapabilities).toContain('todos.add');
      expect(blueprint.userModifications).toEqual([]);
    });

    it('turns open questions into ambiguities and falls back to the description as goal', () => {
      const blueprint = generator.deriveFromComposition(
        { goal: '', assumptions: [], openQuestions: ['One or many lists?'] },
        SAMPLE_TODO_CONTRACT as any,
        'a todo app'
      );

      expect(blueprint.goal).toBe('a todo app');
      expect(blueprint.ambiguities).toHaveLength(1);
      expect(blueprint.ambiguities[0].question).toBe('One or many lists?');
      expect(blueprint.ambiguities[0].options).toEqual([]);
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