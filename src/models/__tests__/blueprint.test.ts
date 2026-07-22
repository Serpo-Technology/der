/**
 * Tests for Blueprint model
 * Requirements: 1.2, 1.3
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Blueprint } from '../blueprint';
import { validateBlueprint } from '../../utils/validation';
import type { UIElementRequirement, OperationRequirement, Ambiguity } from '../../types';

describe('Blueprint Model', () => {
  let blueprint: Blueprint;

  beforeEach(() => {
    blueprint = new Blueprint();
  });

  describe('Construction', () => {
    it('should create an empty blueprint with default values', () => {
      expect(blueprint.description).toBe('');
      expect(blueprint.goal).toBe('');
      expect(blueprint.requiredCapabilities).toEqual([]);
      expect(blueprint.uiElements).toEqual([]);
      expect(blueprint.operations).toEqual([]);
      expect(blueprint.ambiguities).toEqual([]);
      expect(blueprint.userModifications).toBeUndefined();
    });

    it('should create a blueprint with provided data', () => {
      const data = {
        description: 'Test app',
        goal: 'Test user interactions',
        requiredCapabilities: ['input', 'display'],
        uiElements: [{
          type: 'button',
          purpose: 'Submit',
          capabilities: ['input']
        }],
        operations: [{
          name: 'submit',
          purpose: 'Submit data',
          inputs: ['data'],
          outputs: ['result'],
          executionType: 'remote' as const
        }],
        ambiguities: []
      };

      const bp = new Blueprint(data);
      expect(bp.description).toBe('Test app');
      expect(bp.goal).toBe('Test user interactions');
      expect(bp.requiredCapabilities).toEqual(['input', 'display']);
      expect(bp.uiElements).toHaveLength(1);
      expect(bp.operations).toHaveLength(1);
    });

    it('should create blueprint from description', () => {
      const bp = Blueprint.fromDescription('Create a todo app');
      expect(bp.description).toBe('Create a todo app');
      expect(bp.goal).toBe('');
      expect(bp.uiElements).toEqual([]);
    });
  });

  describe('JSON Serialization', () => {
    beforeEach(() => {
      blueprint.description = 'Test app';
      blueprint.goal = 'Test interactions';
      blueprint.addCapability('input');
      blueprint.addUIElement({
        type: 'button',
        purpose: 'Submit',
        capabilities: ['input']
      });
      blueprint.addOperation({
        name: 'submit',
        purpose: 'Submit data',
        inputs: ['data'],
        outputs: ['result'],
        executionType: 'remote'
      });
    });

    it('should serialize to a JSON string via toJSONString and a plain object via toJSON', () => {
      expect(typeof blueprint.toJSON()).toBe('object');
      const json = blueprint.toJSONString();
      expect(typeof json).toBe('string');

      const parsed = JSON.parse(json);
      expect(parsed.description).toBe('Test app');
      expect(parsed.goal).toBe('Test interactions');
      expect(parsed.requiredCapabilities).toEqual(['input']);
      expect(parsed.uiElements).toHaveLength(1);
      expect(parsed.operations).toHaveLength(1);
    });

    it('should deserialize from JSON string', () => {
      const json = blueprint.toJSONString();
      const restored = Blueprint.fromJSON(json);
      
      expect(restored.description).toBe(blueprint.description);
      expect(restored.goal).toBe(blueprint.goal);
      expect(restored.requiredCapabilities).toEqual(blueprint.requiredCapabilities);
      expect(restored.uiElements).toEqual(blueprint.uiElements);
      expect(restored.operations).toEqual(blueprint.operations);
    });

    it('should handle invalid JSON gracefully', () => {
      expect(() => Blueprint.fromJSON('invalid json')).toThrow('Invalid JSON format');
    });

    it('should convert to plain object', () => {
      const obj = blueprint.toObject();
      expect(obj).toEqual({
        description: 'Test app',
        goal: 'Test interactions',
        requiredCapabilities: ['input'],
        uiElements: [{
          type: 'button',
          purpose: 'Submit',
          capabilities: ['input']
        }],
        operations: [{
          name: 'submit',
          purpose: 'Submit data',
          inputs: ['data'],
          outputs: ['result'],
          executionType: 'remote'
        }],
        ambiguities: [],
        userModifications: undefined
      });
    });

    it('should create from object', () => {
      const obj = blueprint.toObject();
      const restored = Blueprint.fromObject(obj);
      
      expect(restored.description).toBe(blueprint.description);
      expect(restored.goal).toBe(blueprint.goal);
      expect(restored.requiredCapabilities).toEqual(blueprint.requiredCapabilities);
    });

    it('should handle user modifications with dates', () => {
      blueprint.recordUserModification('description', 'old', 'new');
      const json = blueprint.toJSONString();
      const restored = Blueprint.fromJSON(json);
      
      expect(restored.userModifications).toHaveLength(1);
      expect(restored.userModifications![0].location).toBe('description');
      expect(restored.userModifications![0].timestamp).toBeInstanceOf(Date);
    });
  });

  describe('Validation', () => {
    it('should validate a complete blueprint', () => {
      blueprint.description = 'Test app';
      blueprint.goal = 'Test interactions';
      blueprint.addCapability('input');
      blueprint.addUIElement({
        type: 'button',
        purpose: 'Submit',
        capabilities: ['input']
      });
      blueprint.addOperation({
        name: 'submit',
        purpose: 'Submit data',
        inputs: ['data'],
        outputs: ['result'],
        executionType: 'remote'
      });

      const result = blueprint.validate();
      expect(result.isValid).toBe(true);
      expect(blueprint.isValid()).toBe(true);
    });

    it('should detect validation errors', () => {
      // Blueprint with invalid data types should have validation issues
      const invalidData = {
        description: 123, // Should be string
        goal: 'Valid goal',
        requiredCapabilities: 'not-an-array', // Should be array
        uiElements: [],
        operations: [],
        ambiguities: []
      };
      
      const result = validateBlueprint(invalidData as any);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should generate warnings for empty blueprint', () => {
      // Empty but valid blueprint should generate warnings
      const result = blueprint.validate();
      expect(result.isValid).toBe(true); // Schema-wise valid
      expect(result.warnings.some(w => w.code === 'NO_UI_ELEMENTS')).toBe(true);
      expect(result.warnings.some(w => w.code === 'NO_OPERATIONS')).toBe(true);
    });
  });

  describe('UI Element Management', () => {
    const testElement: UIElementRequirement = {
      type: 'button',
      purpose: 'Submit form',
      capabilities: ['input']
    };

    it('should add UI elements', () => {
      blueprint.addUIElement(testElement);
      expect(blueprint.uiElements).toHaveLength(1);
      expect(blueprint.uiElements[0]).toEqual(testElement);
    });

    it('should remove UI elements by index', () => {
      blueprint.addUIElement(testElement);
      blueprint.addUIElement({ ...testElement, type: 'input' });
      
      expect(blueprint.removeUIElement(0)).toBe(true);
      expect(blueprint.uiElements).toHaveLength(1);
      expect(blueprint.uiElements[0].type).toBe('input');
    });

    it('should handle invalid removal index', () => {
      expect(blueprint.removeUIElement(0)).toBe(false);
      expect(blueprint.removeUIElement(-1)).toBe(false);
    });

    it('should update UI elements', () => {
      blueprint.addUIElement(testElement);
      
      expect(blueprint.updateUIElement(0, { type: 'input' })).toBe(true);
      expect(blueprint.uiElements[0].type).toBe('input');
      expect(blueprint.uiElements[0].purpose).toBe('Submit form'); // Should preserve other properties
    });

    it('should handle invalid update index', () => {
      expect(blueprint.updateUIElement(0, { type: 'input' })).toBe(false);
    });
  });

  describe('Operation Management', () => {
    const testOperation: OperationRequirement = {
      name: 'submit',
      purpose: 'Submit data',
      inputs: ['data'],
      outputs: ['result'],
      executionType: 'remote'
    };

    it('should add operations', () => {
      blueprint.addOperation(testOperation);
      expect(blueprint.operations).toHaveLength(1);
      expect(blueprint.operations[0]).toEqual(testOperation);
    });

    it('should remove operations by index', () => {
      blueprint.addOperation(testOperation);
      blueprint.addOperation({ ...testOperation, name: 'delete' });
      
      expect(blueprint.removeOperation(0)).toBe(true);
      expect(blueprint.operations).toHaveLength(1);
      expect(blueprint.operations[0].name).toBe('delete');
    });

    it('should update operations', () => {
      blueprint.addOperation(testOperation);
      
      expect(blueprint.updateOperation(0, { name: 'update' })).toBe(true);
      expect(blueprint.operations[0].name).toBe('update');
      expect(blueprint.operations[0].purpose).toBe('Submit data'); // Should preserve other properties
    });
  });

  describe('Capability Management', () => {
    it('should add capabilities', () => {
      blueprint.addCapability('input');
      blueprint.addCapability('display');
      
      expect(blueprint.requiredCapabilities).toEqual(['input', 'display']);
    });

    it('should not add duplicate capabilities', () => {
      blueprint.addCapability('input');
      blueprint.addCapability('input');
      
      expect(blueprint.requiredCapabilities).toEqual(['input']);
    });

    it('should remove capabilities', () => {
      blueprint.addCapability('input');
      blueprint.addCapability('display');
      
      expect(blueprint.removeCapability('input')).toBe(true);
      expect(blueprint.requiredCapabilities).toEqual(['display']);
    });

    it('should handle removing non-existent capabilities', () => {
      expect(blueprint.removeCapability('nonexistent')).toBe(false);
    });
  });

  describe('Ambiguity Management', () => {
    const testAmbiguity: Ambiguity = {
      id: 'amb1',
      description: 'Unclear requirement',
      options: ['Option A', 'Option B'],
      question: 'Which option do you prefer?'
    };

    it('should add ambiguities', () => {
      blueprint.addAmbiguity(testAmbiguity);
      expect(blueprint.ambiguities).toHaveLength(1);
      expect(blueprint.hasAmbiguities()).toBe(true);
    });

    it('should remove ambiguities by ID', () => {
      blueprint.addAmbiguity(testAmbiguity);
      blueprint.addAmbiguity({ ...testAmbiguity, id: 'amb2' });
      
      expect(blueprint.removeAmbiguity('amb1')).toBe(true);
      expect(blueprint.ambiguities).toHaveLength(1);
      expect(blueprint.ambiguities[0].id).toBe('amb2');
    });

    it('should clear all ambiguities', () => {
      blueprint.addAmbiguity(testAmbiguity);
      blueprint.addAmbiguity({ ...testAmbiguity, id: 'amb2' });
      
      blueprint.clearAmbiguities();
      expect(blueprint.ambiguities).toHaveLength(0);
      expect(blueprint.hasAmbiguities()).toBe(false);
    });
  });

  describe('User Modification Tracking', () => {
    it('should record user modifications', () => {
      blueprint.recordUserModification('description', 'old value', 'new value');
      
      const modifications = blueprint.getUserModifications();
      expect(modifications).toHaveLength(1);
      expect(modifications[0].location).toBe('description');
      expect(modifications[0].originalValue).toBe('old value');
      expect(modifications[0].newValue).toBe('new value');
      expect(modifications[0].preserved).toBe(true);
      expect(modifications[0].timestamp).toBeInstanceOf(Date);
    });

    it('should get modifications by location', () => {
      blueprint.recordUserModification('description', 'old1', 'new1');
      blueprint.recordUserModification('goal', 'old2', 'new2');
      blueprint.recordUserModification('description', 'old3', 'new3');
      
      const descriptionMods = blueprint.getUserModifications('description');
      expect(descriptionMods).toHaveLength(2);
      expect(descriptionMods.every(mod => mod.location === 'description')).toBe(true);
    });

    it('should return empty array when no modifications exist', () => {
      expect(blueprint.getUserModifications()).toEqual([]);
      expect(blueprint.getUserModifications('description')).toEqual([]);
    });
  });

  describe('Utility Methods', () => {
    beforeEach(() => {
      blueprint.description = 'Test app';
      blueprint.goal = 'Test interactions';
      blueprint.addCapability('input');
      blueprint.addUIElement({
        type: 'button',
        purpose: 'Submit',
        capabilities: ['input']
      });
      blueprint.addOperation({
        name: 'submit',
        purpose: 'Submit data',
        inputs: ['data'],
        outputs: ['result'],
        executionType: 'remote'
      });
      blueprint.addAmbiguity({
        id: 'amb1',
        description: 'Test ambiguity',
        options: ['A', 'B'],
        question: 'Choose?'
      });
      blueprint.recordUserModification('test', 'old', 'new');
    });

    it('should provide a summary', () => {
      const summary = blueprint.getSummary();
      
      expect(summary).toEqual({
        description: 'Test app',
        goal: 'Test interactions',
        elementCount: 1,
        operationCount: 1,
        capabilityCount: 1,
        ambiguityCount: 1,
        hasUserModifications: true
      });
    });

    it('should clone the blueprint', () => {
      const clone = blueprint.clone();
      
      expect(clone).not.toBe(blueprint);
      expect(clone.description).toBe(blueprint.description);
      expect(clone.uiElements).toEqual(blueprint.uiElements);
      expect(clone.operations).toEqual(blueprint.operations);
      
      // Verify deep copy
      clone.description = 'Modified';
      expect(blueprint.description).toBe('Test app');
    });

    it('should merge blueprints', () => {
      const other = new Blueprint({
        description: 'Other app',
        goal: 'Other goal',
        requiredCapabilities: ['display', 'storage'],
        uiElements: [{
          type: 'input',
          purpose: 'Enter data',
          capabilities: ['input']
        }],
        operations: [{
          name: 'save',
          purpose: 'Save data',
          inputs: ['data'],
          outputs: [],
          executionType: 'local'
        }],
        ambiguities: [{
          id: 'amb2',
          description: 'Other ambiguity',
          options: ['X', 'Y'],
          question: 'Pick one?'
        }]
      });

      blueprint.merge(other);
      
      expect(blueprint.requiredCapabilities).toContain('display');
      expect(blueprint.requiredCapabilities).toContain('storage');
      expect(blueprint.uiElements).toHaveLength(2);
      expect(blueprint.operations).toHaveLength(2);
      expect(blueprint.ambiguities).toHaveLength(2);
      
      // Original values should be preserved
      expect(blueprint.description).toBe('Test app');
      expect(blueprint.goal).toBe('Test interactions');
    });

    it('should merge into empty blueprint', () => {
      const empty = new Blueprint();
      const other = new Blueprint({
        description: 'Other app',
        goal: 'Other goal'
      });

      empty.merge(other);
      
      expect(empty.description).toBe('Other app');
      expect(empty.goal).toBe('Other goal');
    });
  });
});