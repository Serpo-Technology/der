/**
 * Integration Tests: User Editing and Conflict Resolution Workflows
 * Tests the complete editing experience and conflict resolution mechanisms
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIInterpreterService } from '../../services/ai-interpreter';
import { ExperienceEditorService } from '../../services/edit-preservation/ExperienceEditorService';
import { ConflictResolver } from '../../services/edit-preservation/ConflictResolver';
import { EditTracker } from '../../services/edit-preservation/EditTracker';
import { Blueprint } from '../../models/blueprint';
import { Contract } from '../../models/contract';
import type { EditOperation, ConflictResolution } from '../../types/experience';

// Mock external dependencies
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('User Editing and Conflict Resolution Workflows', () => {
  let aiInterpreter: AIInterpreterService;
  let editorService: ExperienceEditorService;
  let conflictResolver: ConflictResolver;
  let editTracker: EditTracker;

  const mockInitialContract: Contract = {
    name: 'Simple Form',
    version: '1.0.0',
    elements: [
      {
        id: 'submit-button',
        type: 'button',
        properties: {
          text: 'Submit',
          backgroundColor: '#007bff'
        },
        dataBindings: [],
        eventBindings: [
          {
            event: 'onClick',
            action: {
              type: 'executeOperation',
              operationId: 'submit-form'
            }
          }
        ]
      },
      {
        id: 'email-input',
        type: 'input',
        properties: {
          placeholder: 'Enter email',
          type: 'email'
        },
        dataBindings: [
          {
            property: 'value',
            source: {
              type: 'state',
              key: 'email'
            }
          }
        ],
        eventBindings: []
      }
    ],
    operations: [
      {
        id: 'submit-form',
        type: 'api-call',
        inputMappings: [
          {
            operationInput: 'data',
            source: {
              type: 'state',
              key: 'formData'
            }
          }
        ]
      }
    ],
    operationBindings: []
  };

  beforeEach(async () => {
    aiInterpreter = new AIInterpreterService();
    editorService = new ExperienceEditorService();
    conflictResolver = new ConflictResolver();
    editTracker = new EditTracker();

    // Initialize with mock contract
    await editorService.initializeExperience('test-experience', mockInitialContract);
  });

  describe('Basic Editing Operations', () => {
    it('should track user edits to UI elements', async () => {
      const experienceId = 'test-experience';
      
      // User edits button text
      const editOperation: EditOperation = {
        id: 'edit-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-123'
      };

      await editorService.applyEdit(experienceId, editOperation);
      
      const currentContract = await editorService.getCurrentContract(experienceId);
      const buttonElement = currentContract.elements.find(el => el.id === 'submit-button');
      
      expect(buttonElement?.properties.text).toBe('Send Message');
      
      // Check edit history
      const editHistory = await editTracker.getEditHistory(experienceId);
      expect(editHistory).toHaveLength(1);
      expect(editHistory[0]).toEqual(editOperation);
    });

    it('should handle multiple sequential edits', async () => {
      const experienceId = 'test-experience';
      
      const edits: EditOperation[] = [
        {
          id: 'edit-1',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'text',
          oldValue: 'Submit',
          newValue: 'Send',
          userId: 'user-123'
        },
        {
          id: 'edit-2',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'backgroundColor',
          oldValue: '#007bff',
          newValue: '#28a745',
          userId: 'user-123'
        },
        {
          id: 'edit-3',
          type: 'element-add',
          timestamp: new Date(),
          elementId: 'cancel-button',
          elementData: {
            id: 'cancel-button',
            type: 'button',
            properties: {
              text: 'Cancel',
              backgroundColor: '#6c757d'
            },
            dataBindings: [],
            eventBindings: []
          },
          userId: 'user-123'
        }
      ];

      // Apply edits sequentially
      for (const edit of edits) {
        await editorService.applyEdit(experienceId, edit);
      }

      const finalContract = await editorService.getCurrentContract(experienceId);
      
      // Verify all edits were applied
      const submitButton = finalContract.elements.find(el => el.id === 'submit-button');
      expect(submitButton?.properties.text).toBe('Send');
      expect(submitButton?.properties.backgroundColor).toBe('#28a745');
      
      const cancelButton = finalContract.elements.find(el => el.id === 'cancel-button');
      expect(cancelButton).toBeDefined();
      expect(cancelButton?.properties.text).toBe('Cancel');
      
      // Verify edit history
      const editHistory = await editTracker.getEditHistory(experienceId);
      expect(editHistory).toHaveLength(3);
    });

    it('should support undo and redo operations', async () => {
      const experienceId = 'test-experience';
      
      // Apply an edit
      const edit: EditOperation = {
        id: 'edit-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-123'
      };

      await editorService.applyEdit(experienceId, edit);
      
      let contract = await editorService.getCurrentContract(experienceId);
      let button = contract.elements.find(el => el.id === 'submit-button');
      expect(button?.properties.text).toBe('Send Message');

      // Undo the edit
      await editorService.undoLastEdit(experienceId);
      
      contract = await editorService.getCurrentContract(experienceId);
      button = contract.elements.find(el => el.id === 'submit-button');
      expect(button?.properties.text).toBe('Submit');

      // Redo the edit
      await editorService.redoLastEdit(experienceId);
      
      contract = await editorService.getCurrentContract(experienceId);
      button = contract.elements.find(el => el.id === 'submit-button');
      expect(button?.properties.text).toBe('Send Message');
    });
  });

  describe('AI Regeneration with Edit Preservation', () => {
    it('should preserve user edits during AI regeneration', async () => {
      const experienceId = 'test-experience';
      
      // User makes edits
      const userEdit: EditOperation = {
        id: 'user-edit-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Now',
        userId: 'user-123'
      };

      await editorService.applyEdit(experienceId, userEdit);

      // AI regenerates based on new input
      const newBlueprint = new Blueprint({
        intent: 'Create a form with validation',
        capabilities: ['form', 'validation', 'submit'],
        requirements: ['Add email validation', 'Keep existing styling'],
        context: {}
      });

      const aiGeneratedContract: Contract = {
        ...mockInitialContract,
        elements: [
          ...mockInitialContract.elements,
          {
            id: 'validation-message',
            type: 'text',
            properties: {
              text: 'Please enter a valid email',
              color: '#dc3545'
            },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      // Apply regeneration with preservation
      const preservedContract = await editorService.regenerateWithPreservation(
        experienceId,
        aiGeneratedContract
      );

      // User edits should be preserved
      const submitButton = preservedContract.elements.find(el => el.id === 'submit-button');
      expect(submitButton?.properties.text).toBe('Send Now'); // User edit preserved

      // AI additions should be included
      const validationMessage = preservedContract.elements.find(el => el.id === 'validation-message');
      expect(validationMessage).toBeDefined();
    });

    it('should handle conflicts between user edits and AI changes', async () => {
      const experienceId = 'test-experience';
      
      // User edits button color
      const userEdit: EditOperation = {
        id: 'user-color-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'backgroundColor',
        oldValue: '#007bff',
        newValue: '#ff6b6b',
        userId: 'user-123'
      };

      await editorService.applyEdit(experienceId, userEdit);

      // AI also wants to change button color
      const aiGeneratedContract: Contract = {
        ...mockInitialContract,
        elements: mockInitialContract.elements.map(el => 
          el.id === 'submit-button' 
            ? { ...el, properties: { ...el.properties, backgroundColor: '#28a745' } }
            : el
        )
      };

      // This should create a conflict
      const conflicts = await conflictResolver.detectConflicts(
        await editorService.getCurrentContract(experienceId),
        aiGeneratedContract
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('property-conflict');
      expect(conflicts[0].elementId).toBe('submit-button');
      expect(conflicts[0].property).toBe('backgroundColor');

      // Resolve conflict in favor of user
      const resolution: ConflictResolution = {
        conflictId: conflicts[0].id,
        resolution: 'keep-user',
        resolvedValue: '#ff6b6b'
      };

      const resolvedContract = await conflictResolver.resolveConflict(
        conflicts[0],
        resolution,
        await editorService.getCurrentContract(experienceId),
        aiGeneratedContract
      );

      const button = resolvedContract.elements.find(el => el.id === 'submit-button');
      expect(button?.properties.backgroundColor).toBe('#ff6b6b');
    });

    it('should handle complex multi-property conflicts', async () => {
      const experienceId = 'test-experience';
      
      // User makes multiple edits to the same element
      const userEdits: EditOperation[] = [
        {
          id: 'edit-text',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'text',
          oldValue: 'Submit',
          newValue: 'Send Message',
          userId: 'user-123'
        },
        {
          id: 'edit-color',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'backgroundColor',
          oldValue: '#007bff',
          newValue: '#ff6b6b',
          userId: 'user-123'
        }
      ];

      for (const edit of userEdits) {
        await editorService.applyEdit(experienceId, edit);
      }

      // AI makes conflicting changes
      const aiContract: Contract = {
        ...mockInitialContract,
        elements: mockInitialContract.elements.map(el => 
          el.id === 'submit-button' 
            ? { 
                ...el, 
                properties: { 
                  ...el.properties, 
                  text: 'Submit Form',
                  backgroundColor: '#28a745',
                  size: 'large' // New property from AI
                } 
              }
            : el
        )
      };

      const conflicts = await conflictResolver.detectConflicts(
        await editorService.getCurrentContract(experienceId),
        aiContract
      );

      expect(conflicts).toHaveLength(2); // Text and color conflicts

      // Resolve conflicts with mixed strategy
      const resolutions: ConflictResolution[] = [
        {
          conflictId: conflicts.find(c => c.property === 'text')!.id,
          resolution: 'keep-user',
          resolvedValue: 'Send Message'
        },
        {
          conflictId: conflicts.find(c => c.property === 'backgroundColor')!.id,
          resolution: 'keep-ai',
          resolvedValue: '#28a745'
        }
      ];

      let resolvedContract = await editorService.getCurrentContract(experienceId);
      for (let i = 0; i < conflicts.length; i++) {
        resolvedContract = await conflictResolver.resolveConflict(
          conflicts[i],
          resolutions[i],
          resolvedContract,
          aiContract
        );
      }

      const button = resolvedContract.elements.find(el => el.id === 'submit-button');
      expect(button?.properties.text).toBe('Send Message'); // User preference
      expect(button?.properties.backgroundColor).toBe('#28a745'); // AI preference
      expect(button?.properties.size).toBe('large'); // AI addition (no conflict)
    });
  });

  describe('Collaborative Editing', () => {
    it('should handle concurrent edits from multiple users', async () => {
      const experienceId = 'test-experience';
      
      // Simulate two users editing simultaneously
      const user1Edit: EditOperation = {
        id: 'user1-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send',
        userId: 'user-1'
      };

      const user2Edit: EditOperation = {
        id: 'user2-edit',
        type: 'property-change',
        timestamp: new Date(Date.now() + 100), // Slightly later
        elementId: 'email-input',
        property: 'placeholder',
        oldValue: 'Enter email',
        newValue: 'Your email address',
        userId: 'user-2'
      };

      // Apply edits concurrently
      await Promise.all([
        editorService.applyEdit(experienceId, user1Edit),
        editorService.applyEdit(experienceId, user2Edit)
      ]);

      const finalContract = await editorService.getCurrentContract(experienceId);
      
      // Both edits should be applied
      const button = finalContract.elements.find(el => el.id === 'submit-button');
      const input = finalContract.elements.find(el => el.id === 'email-input');
      
      expect(button?.properties.text).toBe('Send');
      expect(input?.properties.placeholder).toBe('Your email address');

      // Edit history should contain both edits
      const editHistory = await editTracker.getEditHistory(experienceId);
      expect(editHistory).toHaveLength(2);
    });

    it('should resolve concurrent conflicting edits', async () => {
      const experienceId = 'test-experience';
      
      // Two users edit the same property simultaneously
      const user1Edit: EditOperation = {
        id: 'user1-conflict',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Now',
        userId: 'user-1'
      };

      const user2Edit: EditOperation = {
        id: 'user2-conflict',
        type: 'property-change',
        timestamp: new Date(Date.now() + 50), // Slightly later
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Submit Form',
        userId: 'user-2'
      };

      // Apply first edit
      await editorService.applyEdit(experienceId, user1Edit);
      
      // Second edit should detect conflict
      const conflictDetected = await editorService.applyEditWithConflictDetection(
        experienceId, 
        user2Edit
      );

      expect(conflictDetected.hasConflict).toBe(true);
      expect(conflictDetected.conflict?.type).toBe('concurrent-edit');

      // Resolve in favor of later edit (user-2)
      const resolution: ConflictResolution = {
        conflictId: conflictDetected.conflict!.id,
        resolution: 'keep-incoming',
        resolvedValue: 'Submit Form'
      };

      await editorService.resolveEditConflict(experienceId, resolution);

      const finalContract = await editorService.getCurrentContract(experienceId);
      const button = finalContract.elements.find(el => el.id === 'submit-button');
      
      expect(button?.properties.text).toBe('Submit Form');
    });
  });

  describe('Edit Validation and Rollback', () => {
    it('should validate edits before applying', async () => {
      const experienceId = 'test-experience';
      
      // Invalid edit (non-existent element)
      const invalidEdit: EditOperation = {
        id: 'invalid-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'non-existent-element',
        property: 'text',
        oldValue: 'old',
        newValue: 'new',
        userId: 'user-123'
      };

      await expect(
        editorService.applyEdit(experienceId, invalidEdit)
      ).rejects.toThrow('Element not found');

      // Contract should remain unchanged
      const contract = await editorService.getCurrentContract(experienceId);
      expect(contract).toEqual(mockInitialContract);
    });

    it('should support rollback to previous versions', async () => {
      const experienceId = 'test-experience';
      
      // Apply several edits
      const edits: EditOperation[] = [
        {
          id: 'edit-1',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'text',
          oldValue: 'Submit',
          newValue: 'Send',
          userId: 'user-123'
        },
        {
          id: 'edit-2',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'backgroundColor',
          oldValue: '#007bff',
          newValue: '#28a745',
          userId: 'user-123'
        }
      ];

      for (const edit of edits) {
        await editorService.applyEdit(experienceId, edit);
      }

      // Get checkpoint after first edit
      const checkpointId = await editorService.createCheckpoint(experienceId, 'After text change');
      
      // Apply more edits
      await editorService.applyEdit(experienceId, {
        id: 'edit-3',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'email-input',
        property: 'placeholder',
        oldValue: 'Enter email',
        newValue: 'Email address',
        userId: 'user-123'
      });

      // Rollback to checkpoint
      await editorService.rollbackToCheckpoint(experienceId, checkpointId);

      const rolledBackContract = await editorService.getCurrentContract(experienceId);
      const button = rolledBackContract.elements.find(el => el.id === 'submit-button');
      const input = rolledBackContract.elements.find(el => el.id === 'email-input');

      expect(button?.properties.text).toBe('Send'); // Should have first edit
      expect(button?.properties.backgroundColor).toBe('#28a745'); // Should have second edit
      expect(input?.properties.placeholder).toBe('Enter email'); // Should not have third edit
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large edit histories efficiently', async () => {
      const experienceId = 'test-experience';
      
      // Generate many edits
      const manyEdits: EditOperation[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `edit-${i}`,
        type: 'property-change',
        timestamp: new Date(Date.now() + i),
        elementId: 'submit-button',
        property: 'text',
        oldValue: `Text ${i}`,
        newValue: `Text ${i + 1}`,
        userId: 'user-123'
      }));

      const startTime = Date.now();
      
      // Apply all edits
      for (const edit of manyEdits) {
        await editorService.applyEdit(experienceId, edit);
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within reasonable time
      expect(duration).toBeLessThan(5000); // 5 seconds for 1000 edits

      // Final state should be correct
      const finalContract = await editorService.getCurrentContract(experienceId);
      const button = finalContract.elements.find(el => el.id === 'submit-button');
      expect(button?.properties.text).toBe('Text 1000');
    });

    it('should optimize conflict detection for complex contracts', async () => {
      // Create a complex contract with many elements
      const complexContract: Contract = {
        ...mockInitialContract,
        elements: Array.from({ length: 100 }, (_, i) => ({
          id: `element-${i}`,
          type: 'input',
          properties: { placeholder: `Field ${i}` },
          dataBindings: [],
          eventBindings: []
        }))
      };

      const aiContract: Contract = {
        ...complexContract,
        elements: complexContract.elements.map(el => ({
          ...el,
          properties: { ...el.properties, required: true }
        }))
      };

      const startTime = Date.now();
      
      const conflicts = await conflictResolver.detectConflicts(complexContract, aiContract);
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should detect conflicts quickly even with many elements
      expect(duration).toBeLessThan(1000); // 1 second
      expect(conflicts).toHaveLength(0); // No conflicts in this case
    });
  });
});
