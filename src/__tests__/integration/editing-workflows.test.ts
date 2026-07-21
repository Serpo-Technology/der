/**
 * Integration Tests: User Editing and Conflict Resolution Workflows
 * Exercises the editing services together: ExperienceEditorService applies
 * and tracks edits on Contract models, EditTracker records and preserves
 * them, and ConflictResolver detects and resolves collisions between AI
 * changes and user edits.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExperienceEditorService } from '../../services/edit-preservation/ExperienceEditorService';
import { ConflictResolver } from '../../services/edit-preservation/ConflictResolver';
import { EditTracker } from '../../services/edit-preservation/EditTracker';
import { Contract } from '../../models/contract';
import type { UserEdit } from '../../interfaces/experience-editor';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ success: true }),
}));

function buildContract(): Contract {
  return new Contract({
    name: 'Simple Form',
    version: '1.0.0',
    elements: [
      {
        id: 'submit-button',
        type: 'button',
        properties: { text: 'Submit', backgroundColor: '#007bff' },
        dataBindings: [],
        eventBindings: [{ event: 'click', operationId: 'submit-form' }],
        children: [],
      },
      {
        id: 'email-input',
        type: 'input',
        properties: { placeholder: 'Enter email', type: 'email' },
        dataBindings: [],
        eventBindings: [],
        children: [],
      },
    ],
    operations: [
      {
        id: 'submit-form',
        operationName: 'http.get',
        executionType: 'builtin',
        inputs: [{ name: 'url', source: 'constant', sourceId: 'https://api.example.com/form' }],
        outputs: [],
        triggers: [],
      },
    ],
  });
}

describe('User Editing and Conflict Resolution Workflows', () => {
  let editorService: ExperienceEditorService;
  let conflictResolver: ConflictResolver;
  let editTracker: EditTracker;

  beforeEach(async () => {
    editorService = new ExperienceEditorService();
    conflictResolver = new ConflictResolver();
    editTracker = new EditTracker();

    await editorService.initializeExperience('test-experience', buildContract());
  });

  describe('Basic Editing Operations', () => {
    it('should apply and track user edits to UI elements', async () => {
      const experienceId = 'test-experience';

      await editorService.applyEdit(experienceId, {
        id: 'edit-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-123',
      });

      const currentContract = await editorService.getCurrentContract(experienceId);
      const buttonElement = currentContract?.getElement('submit-button');
      expect(buttonElement?.properties.text).toBe('Send Message');

      const editHistory = await editorService.getEditHistory(experienceId);
      expect(editHistory).toHaveLength(1);
      expect(editHistory[0].newValue).toBe('Send Message');
      expect(editHistory[0].originalValue).toBe('Submit');
    });

    it('should handle multiple sequential edits', async () => {
      const experienceId = 'test-experience';

      const edits = [
        {
          id: 'edit-1',
          type: 'property-change' as const,
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'text',
          oldValue: 'Submit',
          newValue: 'Send',
          userId: 'user-123',
        },
        {
          id: 'edit-2',
          type: 'property-change' as const,
          timestamp: new Date(),
          elementId: 'submit-button',
          property: 'backgroundColor',
          oldValue: '#007bff',
          newValue: '#28a745',
          userId: 'user-123',
        },
        {
          id: 'edit-3',
          type: 'property-change' as const,
          timestamp: new Date(),
          elementId: 'email-input',
          property: 'placeholder',
          oldValue: 'Enter email',
          newValue: 'Your email address',
          userId: 'user-123',
        },
      ];

      for (const edit of edits) {
        await editorService.applyEdit(experienceId, edit);
      }

      const finalContract = await editorService.getCurrentContract(experienceId);
      const submitButton = finalContract?.getElement('submit-button');
      expect(submitButton?.properties.text).toBe('Send');
      expect(submitButton?.properties.backgroundColor).toBe('#28a745');
      expect(finalContract?.getElement('email-input')?.properties.placeholder).toBe(
        'Your email address'
      );

      const editHistory = await editorService.getEditHistory(experienceId);
      expect(editHistory).toHaveLength(3);
    });

    it('should reject unsupported edit types', async () => {
      await expect(
        editorService.applyEdit('test-experience', {
          id: 'edit-x',
          type: 'element-add',
          timestamp: new Date(),
          elementId: 'cancel-button',
          newValue: {},
          userId: 'user-123',
        })
      ).rejects.toThrow('Unsupported edit type');
    });

    it('should support undoing the last edit', async () => {
      const experienceId = 'test-experience';

      await editorService.applyEdit(experienceId, {
        id: 'edit-1',
        type: 'property-change',
        timestamp: new Date(Date.now() + 1000),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-123',
      });

      let contract = await editorService.getCurrentContract(experienceId);
      expect(contract?.getElement('submit-button')?.properties.text).toBe('Send Message');

      await editorService.undoLastEdit(experienceId);

      contract = await editorService.getCurrentContract(experienceId);
      expect(contract?.getElement('submit-button')?.properties.text).toBe('Submit');
    });

    it('should reject edits against missing elements and keep the contract intact', async () => {
      const experienceId = 'test-experience';

      await expect(
        editorService.applyEdit(experienceId, {
          id: 'invalid-edit',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'non-existent-element',
          property: 'text',
          oldValue: 'old',
          newValue: 'new',
          userId: 'user-123',
        })
      ).rejects.toThrow('Element non-existent-element not found');

      const contract = await editorService.getCurrentContract(experienceId);
      expect(contract?.getElement('submit-button')?.properties.text).toBe('Submit');
      expect(contract?.elements).toHaveLength(2);
    });
  });

  describe('Edit Tracking and Preservation', () => {
    it('should track, look up, and preserve edits by location', () => {
      const edit: UserEdit = {
        location: 'elements[0].properties.text',
        originalValue: 'Submit',
        newValue: 'Send Now',
        timestamp: new Date(),
        preserved: false,
      };

      editTracker.trackEdit(edit);

      expect(editTracker.getEdits('elements[0].properties.text')).toHaveLength(1);
      expect(editTracker.getLatestEdit('elements[0].properties.text')?.newValue).toBe('Send Now');
      expect(editTracker.getPreservedEdits()).toHaveLength(0);

      editTracker.preserveEdits([edit]);

      expect(editTracker.getPreservedEdits()).toHaveLength(1);
      expect(editTracker.hasPreservedEdits('elements[0].properties.text')).toBe(true);
    });

    it('should preserve user edits through regeneration', async () => {
      const experienceId = 'test-experience';

      await editorService.applyEdit(experienceId, {
        id: 'user-edit-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-button',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Now',
        userId: 'user-123',
      });

      const regenerated = await editorService.regenerateWithPreservation(experienceId, [
        'elements',
      ]);

      // The regenerated contract retains the user's edit
      expect(regenerated.getElement('submit-button')?.properties.text).toBe('Send Now');

      const current = await editorService.getCurrentContract(experienceId);
      expect(current?.getElement('submit-button')?.properties.text).toBe('Send Now');
    });
  });

  describe('Conflict Detection and Resolution', () => {
    it('should detect conflicts between AI changes and user edits at the same location', () => {
      const userEdit: UserEdit = {
        location: 'elements[0].properties.text',
        originalValue: 'Submit',
        newValue: 'Send Now',
        timestamp: new Date(),
        preserved: true,
      };

      const aiChanges = {
        elements: [{ properties: { text: 'Submit Form' } }],
      };

      const conflicts = conflictResolver.detectConflicts(aiChanges, [userEdit]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('ai-user-conflict');
      expect(conflicts[0].location).toBe('elements[0].properties.text');
      expect(conflicts[0].aiSuggestion).toBe('Submit Form');
      expect(conflicts[0].userEdit).toBe('Send Now');
      const optionIds = conflicts[0].resolutionOptions.map((option) => option.id);
      expect(optionIds).toEqual(expect.arrayContaining(['keep-user', 'keep-ai', 'custom']));
    });

    it('should not report a conflict when AI and user values agree', () => {
      const userEdit: UserEdit = {
        location: 'elements[0].properties.text',
        originalValue: 'Submit',
        newValue: 'Send Now',
        timestamp: new Date(),
        preserved: true,
      };

      const aiChanges = {
        elements: [{ properties: { text: 'Send Now' } }],
      };

      expect(conflictResolver.detectConflicts(aiChanges, [userEdit])).toHaveLength(0);
    });

    it('should resolve conflicts per the selected option', () => {
      const userEdit: UserEdit = {
        location: 'elements[0].properties.backgroundColor',
        originalValue: '#007bff',
        newValue: '#ff6b6b',
        timestamp: new Date(),
        preserved: true,
      };
      const aiChanges = {
        elements: [{ properties: { backgroundColor: '#28a745' } }],
      };
      const [conflict] = conflictResolver.detectConflicts(aiChanges, [userEdit]);
      expect(conflict).toBeDefined();

      const keepUser = conflictResolver.resolveConflict(conflict, {
        conflictId: conflict.location,
        selectedOption: 'keep-user',
      });
      expect(keepUser).toBe('#ff6b6b');

      const keepAi = conflictResolver.resolveConflict(conflict, {
        conflictId: conflict.location,
        selectedOption: 'keep-ai',
      });
      expect(keepAi).toBe('#28a745');

      const custom = conflictResolver.resolveConflict(conflict, {
        conflictId: conflict.location,
        selectedOption: 'custom',
        customValue: '#000000',
      });
      expect(custom).toBe('#000000');

      expect(() =>
        conflictResolver.resolveConflict(conflict, {
          conflictId: conflict.location,
          selectedOption: 'custom',
        })
      ).toThrow('Custom resolution requires a custom value');
    });

    it('should merge preserved user edits over AI changes', () => {
      const aiChanges = {
        elements: [{ properties: { text: 'Submit Form', backgroundColor: '#28a745' } }],
      };
      const userEdits: UserEdit[] = [
        {
          location: 'elements[0].properties.text',
          originalValue: 'Submit',
          newValue: 'Send Now',
          timestamp: new Date(),
          preserved: true,
        },
        {
          location: 'elements[0].properties.backgroundColor',
          originalValue: '#007bff',
          newValue: '#ff6b6b',
          timestamp: new Date(),
          preserved: false,
        },
      ];

      const merged = conflictResolver.mergeChanges(aiChanges, userEdits);

      // Preserved edits win; unpreserved edits give way to the AI value
      expect(merged.elements[0].properties.text).toBe('Send Now');
      expect(merged.elements[0].properties.backgroundColor).toBe('#28a745');
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large edit histories efficiently', async () => {
      const experienceId = 'test-experience';

      const manyEdits = Array.from({ length: 500 }, (_, i) => ({
        id: `edit-${i}`,
        type: 'property-change' as const,
        timestamp: new Date(Date.now() + i),
        elementId: 'submit-button',
        property: 'text',
        oldValue: `Text ${i}`,
        newValue: `Text ${i + 1}`,
        userId: 'user-123',
      }));

      const startTime = Date.now();
      for (const edit of manyEdits) {
        await editorService.applyEdit(experienceId, edit);
      }
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);

      const finalContract = await editorService.getCurrentContract(experienceId);
      expect(finalContract?.getElement('submit-button')?.properties.text).toBe('Text 500');

      const history = await editorService.getEditHistory(experienceId);
      expect(history).toHaveLength(500);
    });

    it('should detect conflicts quickly across many user edits', () => {
      const aiChanges = {
        elements: Array.from({ length: 100 }, (_, i) => ({
          properties: { placeholder: `Field ${i}` },
        })),
      };

      const userEdits: UserEdit[] = Array.from({ length: 100 }, (_, i) => ({
        location: `elements[${i}].properties.placeholder`,
        originalValue: `Field ${i}`,
        newValue: `Field ${i}`,
        timestamp: new Date(),
        preserved: true,
      }));

      const startTime = Date.now();
      const conflicts = conflictResolver.detectConflicts(aiChanges, userEdits);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1000);
      // Values agree everywhere, so nothing conflicts
      expect(conflicts).toHaveLength(0);
    });
  });
});
