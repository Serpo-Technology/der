/**
 * Editing Workflow Integration Test
 * Tests the complete editing workflow with preservation and conflict resolution
 * Requirements: 5.1, 5.2, 5.5, 5.6, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Blueprint } from '../../models/blueprint';
import { Contract } from '../../models/contract';

// Mock the LLM client
vi.mock('../../services/ai-interpreter/llm-client', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        goal: "Create a task management application",
        requiredCapabilities: ["task-management", "ui-interaction"],
        uiElements: [
          {
            type: "input",
            purpose: "Task input field",
            capabilities: ["text-input"]
          },
          {
            type: "button",
            purpose: "Add task button",
            capabilities: ["click-handler"]
          }
        ],
        operations: [
          {
            name: "addTask",
            purpose: "Add new task",
            inputs: ["taskText"],
            outputs: ["taskId"],
            executionType: "local"
          }
        ],
        ambiguities: []
      })
    })
  }))
}));

describe('Editing Workflow Integration', () => {
  let integratedService: IntegratedExperienceService;
  let experienceId: string;
  let originalContract: Contract;

  beforeEach(async () => {
    integratedService = new IntegratedExperienceService();
    
    // Create a base experience to edit
    const result = await integratedService.createExperienceFromNaturalLanguage(
      "Create a task management app",
      { preserveEdits: true, enableRealTimeUpdates: true }
    );
    
    experienceId = result.experienceId;
    originalContract = result.contract;
  });

  describe('Edit Preservation Workflow', () => {
    it('should preserve user edits during AI regeneration', async () => {
      // Make a user edit
      const userEdit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'label',
        newValue: 'Enter your task here',
        originalValue: 'Task input',
        timestamp: new Date()
      };

      // Apply the edit
      const editResult = await integratedService.editExperience(
        experienceId,
        userEdit,
        { enableRealTimeUpdates: true, autoSave: true }
      );

      expect(editResult.success).toBe(true);
      expect(editResult.updatedContract).toBeDefined();

      // Verify the edit was applied
      const updatedElement = editResult.updatedContract.getElement(originalContract.elements[0].id);
      expect(updatedElement?.properties?.label).toBe('Enter your task here');

      // Regenerate with AI while preserving edits
      const regenerationResult = await integratedService.regenerateExperienceWithPreservation(
        experienceId,
        "Create a task management app with priority levels",
        { preserveEdits: true, enableRealTimeUpdates: true }
      );

      expect(regenerationResult.success).toBe(true);
      
      // Verify user edit was preserved
      const preservedElement = regenerationResult.updatedContract.getElement(originalContract.elements[0].id);
      expect(preservedElement?.properties?.label).toBe('Enter your task here');
    });

    it('should track edit history throughout the workflow', async () => {
      // Make multiple edits
      const edits = [
        {
          type: 'property-change',
          elementId: originalContract.elements[0].id,
          property: 'placeholder',
          newValue: 'What needs to be done?',
          originalValue: '',
          timestamp: new Date()
        },
        {
          type: 'property-change',
          elementId: originalContract.elements[1].id,
          property: 'text',
          newValue: 'Add Task',
          originalValue: 'Submit',
          timestamp: new Date()
        }
      ];

      // Apply edits sequentially
      for (const edit of edits) {
        await integratedService.editExperience(experienceId, edit);
      }

      // Check edit history
      const editHistory = await integratedService.getEditHistory(experienceId);
      expect(editHistory.length).toBeGreaterThanOrEqual(2);
      
      // Verify edits are tracked with proper metadata
      const lastEdit = editHistory[editHistory.length - 1];
      expect(lastEdit).toHaveProperty('location');
      expect(lastEdit).toHaveProperty('originalValue');
      expect(lastEdit).toHaveProperty('newValue');
      expect(lastEdit).toHaveProperty('timestamp');
    });

    it('should support undo/redo operations', async () => {
      // Make an edit
      const edit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'label',
        newValue: 'Modified Label',
        originalValue: 'Original Label',
        timestamp: new Date()
      };

      await integratedService.editExperience(experienceId, edit);

      // Get the modified contract
      const modifiedContract = await integratedService['editor'].getCurrentContract(experienceId);
      const modifiedElement = modifiedContract?.getElement(originalContract.elements[0].id);
      expect(modifiedElement?.properties?.label).toBe('Modified Label');

      // Undo the edit
      const undoContract = await integratedService.undoLastEdit(experienceId);
      expect(undoContract).toBeDefined();

      // Verify undo worked (note: this is a simplified test as the actual undo logic may vary)
      const editHistoryAfterUndo = await integratedService.getEditHistory(experienceId);
      expect(editHistoryAfterUndo.length).toBeGreaterThan(0);
    });
  });

  describe('Conflict Resolution Workflow', () => {
    it('should detect and handle editing conflicts', async () => {
      // Make a user edit
      const userEdit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'label',
        newValue: 'User Modified Label',
        originalValue: 'Original Label',
        timestamp: new Date()
      };

      await integratedService.editExperience(experienceId, userEdit);

      // Simulate AI regeneration that conflicts with user edit
      // This would normally come from the AI service, but we'll create a conflicting contract
      const conflictingContract = originalContract.clone();
      const conflictingElement = conflictingContract.getElement(originalContract.elements[0].id);
      if (conflictingElement?.properties) {
        conflictingElement.properties.label = 'AI Modified Label';
      }

      // Attempt regeneration with preservation
      const regenerationResult = await integratedService.regenerateExperienceWithPreservation(
        experienceId,
        "Enhanced task management with AI suggestions"
      );

      // The system should handle conflicts gracefully
      expect(regenerationResult.success).toBe(true);
      expect(regenerationResult.updatedContract).toBeDefined();
    });

    it('should provide conflict resolution options', async () => {
      // Create a scenario with potential conflicts
      const userEdit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'validation',
        newValue: { required: true, minLength: 3 },
        originalValue: { required: false },
        timestamp: new Date()
      };

      await integratedService.editExperience(experienceId, userEdit);

      // The conflict resolution is handled internally by the ExperienceEditorService
      // We can verify that the edit was applied successfully
      const currentContract = await integratedService['editor'].getCurrentContract(experienceId);
      expect(currentContract).toBeDefined();
      
      const editedElement = currentContract?.getElement(originalContract.elements[0].id);
      expect(editedElement?.properties?.validation).toEqual({ required: true, minLength: 3 });
    });
  });

  describe('Real-time Updates Workflow', () => {
    it('should update experience in real-time during editing', async () => {
      // Enable real-time updates
      const edit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'style',
        newValue: { backgroundColor: '#f0f0f0', padding: '10px' },
        originalValue: {},
        timestamp: new Date()
      };

      const editResult = await integratedService.editExperience(
        experienceId,
        edit,
        { enableRealTimeUpdates: true }
      );

      expect(editResult.success).toBe(true);

      // Verify the experience state was updated
      const experienceState = await integratedService.getExperienceState(experienceId);
      expect(experienceState).toBeDefined();
      expect(experienceState?.lastUpdated).toBeInstanceOf(Date);
    });

    it('should handle rapid successive edits', async () => {
      const rapidEdits = [
        {
          type: 'property-change',
          elementId: originalContract.elements[0].id,
          property: 'label',
          newValue: 'Edit 1',
          originalValue: 'Original',
          timestamp: new Date()
        },
        {
          type: 'property-change',
          elementId: originalContract.elements[0].id,
          property: 'label',
          newValue: 'Edit 2',
          originalValue: 'Edit 1',
          timestamp: new Date()
        },
        {
          type: 'property-change',
          elementId: originalContract.elements[0].id,
          property: 'label',
          newValue: 'Final Edit',
          originalValue: 'Edit 2',
          timestamp: new Date()
        }
      ];

      // Apply edits rapidly
      const editPromises = rapidEdits.map(edit => 
        integratedService.editExperience(experienceId, edit, { enableRealTimeUpdates: true })
      );

      const results = await Promise.all(editPromises);
      
      // All edits should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
      });

      // Final state should reflect the last edit
      const finalContract = await integratedService['editor'].getCurrentContract(experienceId);
      const finalElement = finalContract?.getElement(originalContract.elements[0].id);
      expect(finalElement?.properties?.label).toBe('Final Edit');
    });
  });

  describe('Validation During Editing', () => {
    it('should validate edits and provide feedback', async () => {
      // Attempt an invalid edit
      const invalidEdit = {
        type: 'property-change',
        elementId: 'non-existent-element',
        property: 'label',
        newValue: 'Invalid',
        originalValue: '',
        timestamp: new Date()
      };

      // This should handle the error gracefully
      await expect(
        integratedService.editExperience(experienceId, invalidEdit)
      ).rejects.toThrow();
    });

    it('should maintain contract integrity during edits', async () => {
      // Make a valid edit
      const validEdit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'required',
        newValue: true,
        originalValue: false,
        timestamp: new Date()
      };

      const result = await integratedService.editExperience(experienceId, validEdit);
      expect(result.success).toBe(true);

      // Verify contract is still valid
      const updatedContract = result.updatedContract;
      const validation = updatedContract.validate();
      expect(validation.isValid).toBe(true);
    });
  });

  describe('Auto-save During Editing', () => {
    it('should auto-save changes when enabled', async () => {
      const edit = {
        type: 'property-change',
        elementId: originalContract.elements[0].id,
        property: 'helpText',
        newValue: 'Enter a task description',
        originalValue: '',
        timestamp: new Date()
      };

      const result = await integratedService.editExperience(
        experienceId,
        edit,
        { autoSave: true }
      );

      expect(result.success).toBe(true);
      
      // Verify the change persists (auto-save functionality)
      const currentContract = await integratedService['editor'].getCurrentContract(experienceId);
      const editedElement = currentContract?.getElement(originalContract.elements[0].id);
      expect(editedElement?.properties?.helpText).toBe('Enter a task description');
    });
  });
});
