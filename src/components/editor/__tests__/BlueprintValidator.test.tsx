/**
 * Blueprint Validator Tests
 * Requirements: 5.1, 10.2, 10.3
 */

// React import removed - not needed in test files with modern React
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BlueprintValidatorComponent, BlueprintValidator } from '../BlueprintValidator';
import { Blueprint } from '../../../types/blueprint';
import { ValidationResult } from '../../../types/contract';

const validBlueprint: Blueprint = {
  description: 'A comprehensive todo application with user management',
  goal: 'Create a task management system with user authentication',
  requiredCapabilities: ['data-storage', 'user-interface', 'authentication'],
  uiElements: [
    {
      type: 'input',
      purpose: 'Task input field',
      capabilities: ['text-input'],
      properties: { placeholder: 'Enter task...' }
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
  ambiguities: []
};

describe('BlueprintValidator', () => {
  describe('Component', () => {
    it('shows success state for valid blueprint', () => {
      const validation: ValidationResult = {
        isValid: true,
        errors: [],
        warnings: []
      };

      render(
        <BlueprintValidatorComponent
          blueprint={validBlueprint}
          validation={validation}
        />
      );

      expect(screen.getByText('Blueprint is valid')).toBeInTheDocument();
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('shows errors when validation fails', () => {
      const validation: ValidationResult = {
        isValid: false,
        errors: [
          { path: 'description', message: 'Description is required', code: 'REQUIRED_FIELD' },
          { path: 'goal', message: 'Goal is required', code: 'REQUIRED_FIELD' }
        ],
        warnings: []
      };

      render(
        <BlueprintValidatorComponent
          blueprint={validBlueprint}
          validation={validation}
        />
      );

      expect(screen.getByText('Errors (2)')).toBeInTheDocument();
      expect(screen.getByText('Description is required')).toBeInTheDocument();
      expect(screen.getByText('Goal is required')).toBeInTheDocument();
    });

    it('shows warnings when present', () => {
      const validation: ValidationResult = {
        isValid: true,
        errors: [],
        warnings: [
          { path: 'description', message: 'Description is very short - consider adding more detail', code: 'SHORT_CONTENT' }
        ]
      };

      render(
        <BlueprintValidatorComponent
          blueprint={validBlueprint}
          validation={validation}
        />
      );

      expect(screen.getByText('Warnings (1)')).toBeInTheDocument();
      expect(screen.getByText('Description is very short - consider adding more detail')).toBeInTheDocument();
    });

    it('shows both errors and warnings', () => {
      const validation: ValidationResult = {
        isValid: false,
        errors: [
          { path: 'description', message: 'Description is required', code: 'REQUIRED_FIELD' }
        ],
        warnings: [
          { path: 'requiredCapabilities', message: 'No capabilities specified - this may limit functionality', code: 'MISSING_CAPABILITIES' }
        ]
      };

      render(
        <BlueprintValidatorComponent
          blueprint={validBlueprint}
          validation={validation}
        />
      );

      expect(screen.getByText('Errors (1)')).toBeInTheDocument();
      expect(screen.getByText('Warnings (1)')).toBeInTheDocument();
    });
  });

  describe('Validation Logic', () => {
    const validator = new BlueprintValidator();

    it('validates a correct blueprint', () => {
      const result = validator.validate(validBlueprint);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('requires description', () => {
      const blueprint = { ...validBlueprint, description: '' };
      const result = validator.validate(blueprint);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message === 'Description is required')).toBe(true);
    });

    it('requires goal', () => {
      const blueprint = { ...validBlueprint, goal: '' };
      const result = validator.validate(blueprint);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message === 'Goal is required')).toBe(true);
    });

    it('warns about short descriptions', () => {
      const blueprint = { ...validBlueprint, description: 'Short' };
      const result = validator.validate(blueprint);
      
      expect(result.warnings.some(w => w.message === 'Description is very short - consider adding more detail')).toBe(true);
    });

    it('warns about long descriptions', () => {
      const blueprint = { 
        ...validBlueprint, 
        description: 'A'.repeat(1001) 
      };
      const result = validator.validate(blueprint);
      
      expect(result.warnings.some(w => w.message === 'Description is very long - consider breaking it down')).toBe(true);
    });

    it('warns about missing capabilities', () => {
      const blueprint = { ...validBlueprint, requiredCapabilities: [] };
      const result = validator.validate(blueprint);
      
      expect(result.warnings.some(w => w.message === 'No capabilities specified - this may limit functionality')).toBe(true);
    });

    it('warns about missing UI elements', () => {
      const blueprint = { ...validBlueprint, uiElements: [] };
      const result = validator.validate(blueprint);
      
      expect(result.warnings.some(w => w.message === 'No UI elements specified - consider adding some interface elements')).toBe(true);
    });

    it('warns about missing operations', () => {
      const blueprint = { ...validBlueprint, operations: [] };
      const result = validator.validate(blueprint);
      
      expect(result.warnings.some(w => w.message === 'No operations specified - consider adding some functionality')).toBe(true);
    });

    it('warns about ambiguities when core content is missing', () => {
      const blueprint = {
        ...validBlueprint,
        operations: [],
        ambiguities: [
          {
            id: 'amb1',
            description: 'Unclear requirement',
            options: ['Option A', 'Option B'],
            question: 'Which option do you prefer?'
          }
        ]
      };
      const result = validator.validate(blueprint);

      expect(result.warnings.some(w => w.message === '1 ambiguities detected - consider resolving them')).toBe(true);
    });

    it('does not warn about ambiguities when elements and operations exist', () => {
      const blueprint = {
        ...validBlueprint,
        ambiguities: [
          {
            id: 'amb1',
            description: 'Unclear requirement',
            options: ['Option A', 'Option B'],
            question: 'Which option do you prefer?'
          }
        ]
      };
      const result = validator.validate(blueprint);

      expect(result.warnings.some(w => w.code === 'UNRESOLVED_AMBIGUITIES')).toBe(false);
    });

    it('warns about duplicate capabilities', () => {
      const blueprint = { 
        ...validBlueprint, 
        requiredCapabilities: ['data-storage', 'user-interface', 'data-storage'] 
      };
      const result = validator.validate(blueprint);
      
      expect(result.warnings.some(w => w.message === 'Duplicate capabilities found: data-storage')).toBe(true);
    });

    it('validates UI elements', () => {
      const blueprint = { 
        ...validBlueprint, 
        uiElements: [
          {
            type: '',
            purpose: 'Valid purpose',
            capabilities: ['text-input']
          },
          {
            type: 'input',
            purpose: '',
            capabilities: ['text-input']
          }
        ]
      };
      const result = validator.validate(blueprint);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message === 'UI Element 1: Type is required')).toBe(true);
      expect(result.errors.some(e => e.message === 'UI Element 2: Purpose is required')).toBe(true);
    });

    it('validates operations', () => {
      const blueprint = { 
        ...validBlueprint, 
        operations: [
          {
            name: '',
            purpose: 'Valid purpose',
            inputs: ['input1'],
            outputs: ['output1'],
            executionType: 'local'
          },
          {
            name: 'validName',
            purpose: '',
            inputs: ['input1'],
            outputs: ['output1'],
            executionType: 'local'
          },
          {
            name: 'validName',
            purpose: 'Valid purpose',
            inputs: ['input1'],
            outputs: ['output1'],
            executionType: 'invalid' as any
          }
        ]
      };
      const result = validator.validate(blueprint);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message === 'Operation 1: Name is required')).toBe(true);
      expect(result.errors.some(e => e.message === 'Operation 2: Purpose is required')).toBe(true);
      expect(result.errors.some(e => e.message === 'Operation 3: Invalid execution type')).toBe(true);
    });
  });
});