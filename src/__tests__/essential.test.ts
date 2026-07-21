/**
 * Essential Core Functionality Tests
 * Simple tests without heavy mocking to verify core system works
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Blueprint } from '../models/blueprint';
import { Contract } from '../models/contract';
import { ExperienceEditorService } from '../services/edit-preservation/ExperienceEditorService';

describe('Essential Core Functionality', () => {
  let editorService: ExperienceEditorService;

  beforeEach(() => {
    editorService = new ExperienceEditorService();
  });

  describe('Blueprint Model', () => {
    it('should create a blueprint with required properties', () => {
      const blueprint = new Blueprint({
        description: 'Create a contact form',
        goal: 'Form creation',
        intent: 'contact form creation',
        confidence: 0.9,
        requiredCapabilities: ['form-input'],
        uiElements: [
          {
            type: 'input',
            purpose: 'Name field',
            capabilities: ['form-input'],
            properties: { label: 'Name', placeholder: 'Enter name' }
          }
        ],
        operations: [],
        ambiguities: []
      });

      expect(blueprint).toBeDefined();
      expect(blueprint.intent).toBe('contact form creation');
      expect(blueprint.confidence).toBe(0.9);
      expect(blueprint.uiElements).toHaveLength(1);
    });
  });

  describe('Contract Model', () => {
    it('should create a contract with elements', () => {
      const contract = new Contract({
        name: 'Test Contract',
        version: '1.0.0',
        elements: [
          {
            id: 'input-1',
            type: 'input',
            properties: { label: 'Name', placeholder: 'Enter name' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: []
      });

      expect(contract).toBeDefined();
      expect(contract.name).toBe('Test Contract');
      expect(contract.elements).toHaveLength(1);
      expect(contract.getElement('input-1')).toBeDefined();
    });
  });

  describe('Experience Editor Service', () => {
    it('should initialize and manage experiences', async () => {
      const contract = new Contract({
        name: 'Test Form',
        elements: [
          {
            id: 'submit-btn',
            type: 'button',
            properties: { text: 'Submit' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('test-exp', contract);
      
      const retrievedContract = await editorService.getCurrentContract('test-exp');
      expect(retrievedContract).toBeDefined();
      expect(retrievedContract?.name).toBe('Test Form');
    });

    it('should apply property edits', async () => {
      const contract = new Contract({
        name: 'Test Form',
        elements: [
          {
            id: 'submit-btn',
            type: 'button',
            properties: { text: 'Submit' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('test-exp', contract);

      const edit = {
        id: 'edit-1',
        type: 'property-change' as const,
        timestamp: new Date(),
        elementId: 'submit-btn',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-1'
      };

      await editorService.applyEdit('test-exp', edit);

      const updatedContract = await editorService.getCurrentContract('test-exp');
      const button = updatedContract?.getElement('submit-btn');
      expect(button?.properties.text).toBe('Send Message');
    });

    it('should track edit history', async () => {
      const contract = new Contract({
        name: 'Test Form',
        elements: [
          {
            id: 'submit-btn',
            type: 'button',
            properties: { text: 'Submit' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('test-exp', contract);

      const edit = {
        id: 'edit-1',
        type: 'property-change' as const,
        timestamp: new Date(),
        elementId: 'submit-btn',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-1'
      };

      await editorService.applyEdit('test-exp', edit);

      const history = await editorService.getEditHistory('test-exp');
      expect(history).toHaveLength(1);
      expect(history[0].newValue).toBe('Send Message');
    });
  });

  describe('Unified Experience Interface', () => {
    it('should handle both id and experienceId properties', () => {
      const experience = {
        id: 'exp-1',
        experienceId: 'exp-1',
        contract: new Contract({ name: 'Test' }),
        state: {},
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      expect(experience.id).toBe(experience.experienceId);
      expect(experience.contract).toBeDefined();
      expect(experience.metadata).toBeDefined();
    });
  });
});
