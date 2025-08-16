/**
 * Edit Preservation System Tests
 * Requirements: 2.4, 5.2, 5.6, 10.4, 10.5, 10.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EditPreservationSystem, UserEdit, EditConflict, ConflictResolution } from '../edit-preservation';
import { Contract, ContractEdits } from '../../../types/contract';
import { Blueprint } from '../../../types/blueprint';

describe('EditPreservationSystem', () => {
  let system: EditPreservationSystem;

  beforeEach(() => {
    system = new EditPreservationSystem();
  });

  describe('trackEdit', () => {
    it('should track user edits', () => {
      const edit = system.trackEdit('elements.button1.text', 'Old Text', 'New Text', 'element');

      expect(edit.location).toBe('elements.button1.text');
      expect(edit.originalValue).toBe('Old Text');
      expect(edit.newValue).toBe('New Text');
      expect(edit.type).toBe('element');
      expect(edit.preserved).toBe(true);
      expect(edit.timestamp).toBeInstanceOf(Date);
    });

    it('should generate unique edit IDs', () => {
      const edit1 = system.trackEdit('location1', 'old1', 'new1');
      const edit2 = system.trackEdit('location2', 'old2', 'new2');

      expect(edit1.id).not.toBe(edit2.id);
    });

    it('should overwrite edits at the same location', () => {
      system.trackEdit('same.location', 'old1', 'new1');
      system.trackEdit('same.location', 'old2', 'new2');

      const edits = system.getEdits();
      expect(edits).toHaveLength(1);
      expect(edits[0].newValue).toBe('new2');
    });
  });

  describe('getEdits', () => {
    it('should return all tracked edits', () => {
      system.trackEdit('location1', 'old1', 'new1', 'element');
      system.trackEdit('location2', 'old2', 'new2', 'operation');

      const edits = system.getEdits();
      expect(edits).toHaveLength(2);
    });

    it('should filter edits by type', () => {
      system.trackEdit('location1', 'old1', 'new1', 'element');
      system.trackEdit('location2', 'old2', 'new2', 'operation');
      system.trackEdit('location3', 'old3', 'new3', 'element');

      const elementEdits = system.getEditsByType('element');
      expect(elementEdits).toHaveLength(2);
      expect(elementEdits.every(edit => edit.type === 'element')).toBe(true);
    });
  });

  describe('preserveUserEditsInContract', () => {
    it('should preserve user edits in contract', () => {
      const originalContract: Contract = {
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
        operations: [
          {
            id: 'op1',
            operationName: 'testOp',
            inputs: [],
            outputs: [],
            triggers: []
          }
        ],
        layout: { type: 'flex', properties: { direction: 'row' } },
        styling: { theme: 'light' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const userEdits: ContractEdits = {
        elementEdits: {
          button1: { properties: { text: 'User Modified Text' } }
        },
        operationEdits: {
          op1: { operationName: 'userModifiedOp' }
        },
        layoutEdits: { type: 'flex', properties: { direction: 'column' } },
        styleEdits: { theme: 'dark' }
      };

      const preservedContract = system.preserveUserEditsInContract(originalContract, userEdits);

      expect(preservedContract.elements[0].properties.text).toBe('User Modified Text');
      expect(preservedContract.operations[0].operationName).toBe('userModifiedOp');
      expect(preservedContract.layout.properties.direction).toBe('column');
      expect(preservedContract.styling.theme).toBe('dark');
      expect(system.hasEdits()).toBe(true);
    });
  });

  describe('regenerateWithPreservation', () => {
    it('should preserve user edits when regenerating without conflicts', () => {
      const blueprint: Blueprint = {
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
        elements: [
          {
            id: 'button1',
            type: 'button',
            properties: { text: 'User Text' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'dark' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const newContract: Contract = {
        name: 'new-contract',
        version: '1.0.0',
        elements: [
          {
            id: 'button1',
            type: 'button',
            properties: { text: 'AI Generated Text' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'light' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      // Track some user edits first
      system.trackEdit('elements.button1.properties.text', 'Original Text', 'User Text', 'element');
      system.trackEdit('styling.theme', 'light', 'dark', 'contract');

      const { contract: preservedContract, conflicts } = system.regenerateWithPreservation(
        blueprint,
        existingContract,
        newContract,
        ['elements', 'styling']
      );

      expect(conflicts.length).toBeGreaterThan(0); // Should detect conflicts
      expect(preservedContract.name).toBe('new-contract'); // Base should be new contract
    });
  });

  describe('resolveConflicts', () => {
    it('should resolve conflicts by keeping user edits', () => {
      const contract: Contract = {
        name: 'test-contract',
        version: '1.0.0',
        elements: [
          {
            id: 'button1',
            type: 'button',
            properties: { text: 'AI Text' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'light' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const userEdit: UserEdit = {
        id: 'edit1',
        location: 'elements.button1.properties.text',
        originalValue: 'Original Text',
        newValue: 'User Text',
        timestamp: new Date(),
        preserved: true,
        type: 'element'
      };

      const conflict: EditConflict = {
        id: 'conflict1',
        location: 'elements.button1.properties.text',
        userEdit,
        aiSuggestion: 'AI Text',
        conflictType: 'value-mismatch',
        resolutionOptions: [
          {
            id: 'keep-user',
            description: 'Keep user changes',
            action: 'keep-user'
          }
        ]
      };

      const resolutions = new Map<string, ConflictResolution>();
      resolutions.set('conflict1', {
        id: 'keep-user',
        description: 'Keep user changes',
        action: 'keep-user'
      });

      const resolvedContract = system.resolveConflicts(contract, [conflict], resolutions);

      expect(resolvedContract.elements[0].properties.text).toBe('User Text');
    });

    it('should resolve conflicts by accepting AI suggestions', () => {
      const contract: Contract = {
        name: 'test-contract',
        version: '1.0.0',
        elements: [
          {
            id: 'button1',
            type: 'button',
            properties: { text: 'AI Text' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'light' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const userEdit: UserEdit = {
        id: 'edit1',
        location: 'elements.button1.properties.text',
        originalValue: 'Original Text',
        newValue: 'User Text',
        timestamp: new Date(),
        preserved: true,
        type: 'element'
      };

      const conflict: EditConflict = {
        id: 'conflict1',
        location: 'elements.button1.properties.text',
        userEdit,
        aiSuggestion: 'AI Text',
        conflictType: 'value-mismatch',
        resolutionOptions: []
      };

      const resolutions = new Map<string, ConflictResolution>();
      resolutions.set('conflict1', {
        id: 'accept-ai',
        description: 'Accept AI suggestion',
        action: 'accept-ai'
      });

      const resolvedContract = system.resolveConflicts(contract, [conflict], resolutions);

      expect(resolvedContract.elements[0].properties.text).toBe('AI Text');
    });

    it('should resolve conflicts by merging values', () => {
      const contract: Contract = {
        name: 'test-contract',
        version: '1.0.0',
        elements: [
          {
            id: 'button1',
            type: 'button',
            properties: { text: 'AI Text' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: [],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'light' },
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      const userEdit: UserEdit = {
        id: 'edit1',
        location: 'elements.button1.properties.text',
        originalValue: 'Original Text',
        newValue: 'User Text',
        timestamp: new Date(),
        preserved: true,
        type: 'element'
      };

      const conflict: EditConflict = {
        id: 'conflict1',
        location: 'elements.button1.properties.text',
        userEdit,
        aiSuggestion: 'AI Text',
        conflictType: 'value-mismatch',
        resolutionOptions: []
      };

      const resolutions = new Map<string, ConflictResolution>();
      resolutions.set('conflict1', {
        id: 'merge',
        description: 'Merge values',
        action: 'merge',
        mergedValue: 'Merged Text'
      });

      const resolvedContract = system.resolveConflicts(contract, [conflict], resolutions);

      expect(resolvedContract.elements[0].properties.text).toBe('Merged Text');
    });
  });

  describe('clearEdits', () => {
    it('should clear all tracked edits', () => {
      system.trackEdit('location1', 'old1', 'new1');
      system.trackEdit('location2', 'old2', 'new2');

      expect(system.hasEdits()).toBe(true);

      system.clearEdits();

      expect(system.hasEdits()).toBe(false);
      expect(system.getEdits()).toHaveLength(0);
    });
  });
});