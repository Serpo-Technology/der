/**
 * Editing Workflow Integration Test
 * Tests the complete editing workflow with preservation through the
 * IntegratedExperienceService. Generation is LLM-backed through the mocked
 * Tauri `llm_chat` command.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Contract } from '../../models/contract';
import { installInvokeMock } from '../support/tauri-invoke-mock';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn(async () => ({
      execute: vi.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 })),
      select: vi.fn(async () => []),
      close: vi.fn(async () => true),
    })),
  },
}));

describe('Editing Workflow Integration', () => {
  let integratedService: IntegratedExperienceService;
  let experienceId: string;
  let originalContract: Contract;

  beforeEach(async () => {
    installInvokeMock();
    integratedService = new IntegratedExperienceService();

    const result = await integratedService.createExperienceFromNaturalLanguage(
      'Create a task management app',
      { preserveEdits: true, enableRealTimeUpdates: true }
    );

    experienceId = result.experienceId;
    originalContract = result.contract;
  });

  describe('Edit Preservation Workflow', () => {
    it('should preserve user edits during AI regeneration', async () => {
      const userEdit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'content',
        newValue: 'My Curated Tasks',
        originalValue: 'My Todos',
        timestamp: new Date(),
      };

      const editResult = await integratedService.editExperience(experienceId, userEdit, {
        enableRealTimeUpdates: true,
        autoSave: true,
      });

      expect(editResult.success).toBe(true);
      expect(editResult.updatedContract).toBeDefined();

      const updatedElement = editResult.updatedContract.getElement(
        originalContract.elements[0].id
      );
      expect(updatedElement?.properties?.content).toBe('My Curated Tasks');

      // Regenerate with preservation; the LLM legs run against the mock again
      const regenerationResult = await integratedService.regenerateExperienceWithPreservation(
        experienceId,
        'Create a task management app with priority levels',
        { preserveEdits: true, enableRealTimeUpdates: true }
      );

      expect(regenerationResult.success).toBe(true);

      const preservedElement = regenerationResult.updatedContract.getElement(
        originalContract.elements[0].id
      );
      expect(preservedElement?.properties?.content).toBe('My Curated Tasks');
    });

    it('should track edit history throughout the workflow', async () => {
      const edits = [
        {
          type: 'property-change',
          elementId: originalContract.elements[1].id,
          property: 'placeholder',
          newValue: 'What needs to be done?',
          originalValue: 'What needs doing?',
          timestamp: new Date(),
        },
        {
          type: 'property-change',
          elementId: originalContract.elements[2].id,
          property: 'text',
          newValue: 'Add Task',
          originalValue: 'Add',
          timestamp: new Date(),
        },
      ];

      for (const edit of edits) {
        await integratedService.editExperience(experienceId, edit);
      }

      const editHistory = await integratedService.getEditHistory(experienceId);
      expect(editHistory.length).toBeGreaterThanOrEqual(2);

      const lastEdit = editHistory[editHistory.length - 1];
      expect(lastEdit).toHaveProperty('location');
      expect(lastEdit).toHaveProperty('originalValue');
      expect(lastEdit).toHaveProperty('newValue');
      expect(lastEdit).toHaveProperty('timestamp');
    });

    it('should support undo of the last edit', async () => {
      const targetId = originalContract.elements[0].id;
      // Undo reverses the edit whose tracked timestamp sorts last, and the
      // history entry keyed by element and property stores oldValue. Date the
      // edit ahead of the tracker's own wall-clock entries so that entry is
      // deterministically the one reversed.
      const edit = {
        type: 'property-change',
        elementId: targetId,
        property: 'content',
        newValue: 'Modified Title',
        originalValue: 'My Todos',
        oldValue: 'My Todos',
        timestamp: new Date(Date.now() + 1000),
      };

      await integratedService.editExperience(experienceId, edit);

      const modifiedContract = await integratedService['editor'].getCurrentContract(experienceId);
      expect(modifiedContract?.getElement(targetId)?.properties?.content).toBe('Modified Title');

      const undoContract = await integratedService.undoLastEdit(experienceId);
      expect(undoContract).toBeDefined();
      expect(undoContract.getElement(targetId)?.properties?.content).toBe('My Todos');
    });
  });

  describe('Conflict Resolution Workflow', () => {
    it('should regenerate cleanly when user edits do not conflict', async () => {
      const userEdit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'content',
        newValue: 'User Modified Title',
        originalValue: 'My Todos',
        timestamp: new Date(),
      };

      await integratedService.editExperience(experienceId, userEdit);

      const regenerationResult = await integratedService.regenerateExperienceWithPreservation(
        experienceId,
        'Enhanced task management with suggestions'
      );

      expect(regenerationResult.success).toBe(true);
      expect(regenerationResult.updatedContract).toBeDefined();
    });

    it('should apply structured property values through edits', async () => {
      const userEdit = {
        type: 'property-change',
        elementId: originalContract.elements[1].id,
        property: 'validation',
        newValue: { required: true, minLength: 3 },
        originalValue: undefined,
        timestamp: new Date(),
      };

      const result = await integratedService.editExperience(experienceId, userEdit);
      expect(result.success).toBe(true);

      const currentContract = await integratedService['editor'].getCurrentContract(experienceId);
      const editedElement = currentContract?.getElement(originalContract.elements[1].id);
      expect(editedElement?.properties?.validation).toEqual({ required: true, minLength: 3 });
    });
  });

  describe('Real-time Updates Workflow', () => {
    it('should update experience state during editing', async () => {
      const edit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'style',
        newValue: { backgroundColor: '#f0f0f0', padding: '10px' },
        originalValue: {},
        timestamp: new Date(),
      };

      const editResult = await integratedService.editExperience(experienceId, edit, {
        enableRealTimeUpdates: true,
      });

      expect(editResult.success).toBe(true);

      const experienceState = await integratedService.getExperienceState(experienceId);
      expect(experienceState).toBeDefined();
      expect(experienceState?.lastUpdated).toBeInstanceOf(Date);
      // The runtime reseeded state from the updated contract's initialState
      expect(experienceState?.data.todos).toEqual([]);
    });

    it('should handle rapid successive edits', async () => {
      const targetId = originalContract.elements[0].id;
      const rapidEdits = ['Edit 1', 'Edit 2', 'Final Edit'].map((value, index) => ({
        type: 'property-change',
        elementId: targetId,
        property: 'content',
        newValue: value,
        originalValue: index === 0 ? 'My Todos' : `Edit ${index}`,
        timestamp: new Date(),
      }));

      const results = await Promise.all(
        rapidEdits.map((edit) =>
          integratedService.editExperience(experienceId, edit, { enableRealTimeUpdates: true })
        )
      );

      results.forEach((result) => {
        expect(result.success).toBe(true);
      });

      const finalContract = await integratedService['editor'].getCurrentContract(experienceId);
      expect(finalContract?.getElement(targetId)?.properties?.content).toBe('Final Edit');
    });
  });

  describe('Validation During Editing', () => {
    it('should report failure for edits against missing elements without corrupting the contract', async () => {
      const invalidEdit = {
        type: 'property-change',
        elementId: 'non-existent-element',
        property: 'content',
        newValue: 'Invalid',
        originalValue: '',
        timestamp: new Date(),
      };

      const result = await integratedService.editExperience(experienceId, invalidEdit);
      expect(result.success).toBe(false);

      // The contract is still intact and editable
      const contract = await integratedService['editor'].getCurrentContract(experienceId);
      expect(contract?.elements).toHaveLength(originalContract.elements.length);
    });

    it('should maintain contract integrity during edits', async () => {
      const validEdit = {
        type: 'property-change',
        elementId: originalContract.elements[1].id,
        property: 'required',
        newValue: true,
        originalValue: false,
        timestamp: new Date(),
      };

      const result = await integratedService.editExperience(experienceId, validEdit);
      expect(result.success).toBe(true);

      const validation = result.updatedContract.validate();
      expect(validation.isValid).toBe(true);
    });
  });

  describe('Auto-save During Editing', () => {
    it('should auto-save changes when enabled', async () => {
      const edit = {
        type: 'property-change',
        elementId: originalContract.elements[1].id,
        property: 'helpText',
        newValue: 'Enter a task description',
        originalValue: '',
        timestamp: new Date(),
      };

      const result = await integratedService.editExperience(experienceId, edit, {
        autoSave: true,
      });

      expect(result.success).toBe(true);

      const currentContract = await integratedService['editor'].getCurrentContract(experienceId);
      const editedElement = currentContract?.getElement(originalContract.elements[1].id);
      expect(editedElement?.properties?.helpText).toBe('Enter a task description');
    });
  });
});
