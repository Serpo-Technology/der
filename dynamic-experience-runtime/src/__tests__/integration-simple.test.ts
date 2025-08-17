/**
 * Simple Integration Tests
 * Test core integration without complex mocking
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Blueprint } from '../models/blueprint';
import { Contract } from '../models/contract';
import { ExperienceEditorService } from '../services/edit-preservation/ExperienceEditorService';
import { SharingService } from '../services/persistence/SharingService';
import { BookmarkManager } from '../services/persistence/BookmarkManager';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ success: true })
}));

describe('Simple Integration Tests', () => {
  let editorService: ExperienceEditorService;
  let sharingService: SharingService;
  let bookmarkManager: BookmarkManager;

  beforeEach(() => {
    editorService = new ExperienceEditorService();
    sharingService = new SharingService();
    bookmarkManager = new BookmarkManager();
  });

  describe('Blueprint to Contract Flow', () => {
    it('should convert blueprint to contract', () => {
      const blueprint = new Blueprint({
        description: 'Create a simple form',
        goal: 'Form creation',
        intent: 'form creation',
        confidence: 0.9,
        requiredCapabilities: ['form-input'],
        uiElements: [
          {
            type: 'input',
            purpose: 'Name field',
            capabilities: ['form-input'],
            properties: { label: 'Name', placeholder: 'Enter name' }
          },
          {
            type: 'button',
            purpose: 'Submit button',
            capabilities: ['clickable'],
            properties: { text: 'Submit' }
          }
        ],
        operations: [
          {
            name: 'submit-form',
            purpose: 'Submit form data',
            inputs: ['name'],
            outputs: ['success'],
            executionType: 'remote'
          }
        ],
        ambiguities: []
      });

      // Create contract from blueprint data
      const contract = new Contract({
        name: 'Generated Form',
        version: '1.0.0',
        elements: blueprint.uiElements.map((element, index) => ({
          id: `element-${index}`,
          type: element.type,
          properties: element.properties || {},
          dataBindings: [],
          eventBindings: [],
          children: []
        })),
        operations: blueprint.operations.map(op => ({
          id: op.name,
          type: 'api-call',
          inputMappings: []
        }))
      });

      expect(contract).toBeDefined();
      expect(contract.elements).toHaveLength(2);
      expect(contract.elements[0].type).toBe('input');
      expect(contract.elements[1].type).toBe('button');
      expect(contract.operations).toHaveLength(1);
    });
  });

  describe('Experience Editing Workflow', () => {
    it('should handle complete editing workflow', async () => {
      // Create initial contract
      const contract = new Contract({
        name: 'Contact Form',
        elements: [
          {
            id: 'name-input',
            type: 'input',
            properties: { label: 'Name', placeholder: 'Enter your name' },
            dataBindings: [],
            eventBindings: [],
            children: []
          },
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

      // Initialize experience
      await editorService.initializeExperience('contact-form', contract);

      // Apply multiple edits
      const edits = [
        {
          id: 'edit-1',
          type: 'property-change' as const,
          timestamp: new Date(),
          elementId: 'name-input',
          property: 'placeholder',
          oldValue: 'Enter your name',
          newValue: 'Please enter your full name',
          userId: 'user-1'
        },
        {
          id: 'edit-2',
          type: 'property-change' as const,
          timestamp: new Date(),
          elementId: 'submit-btn',
          property: 'text',
          oldValue: 'Submit',
          newValue: 'Send Message',
          userId: 'user-1'
        }
      ];

      for (const edit of edits) {
        await editorService.applyEdit('contact-form', edit);
      }

      // Verify changes
      const updatedContract = await editorService.getCurrentContract('contact-form');
      const nameInput = updatedContract?.getElement('name-input');
      const submitBtn = updatedContract?.getElement('submit-btn');

      expect(nameInput?.properties.placeholder).toBe('Please enter your full name');
      expect(submitBtn?.properties.text).toBe('Send Message');

      // Verify edit history
      const history = await editorService.getEditHistory('contact-form');
      expect(history).toHaveLength(2);
    });
  });

  describe('Sharing and Collaboration', () => {
    it('should handle basic sharing workflow', async () => {
      const contract = new Contract({
        name: 'Shared Form',
        elements: [
          {
            id: 'title',
            type: 'text',
            properties: { text: 'Contact Us' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: []
      });

      // Test collaboration session creation
      const session = await sharingService.createCollaborationSession('shared-form', 'host-user');
      
      expect(session).toBeDefined();
      expect(session.experienceId).toBe('shared-form');
      expect(session.hostUserId).toBe('host-user');
      expect(session.participants).toContain('host-user');
    });
  });

  describe('Performance Characteristics', () => {
    it('should handle multiple concurrent operations efficiently', async () => {
      const startTime = Date.now();
      
      // Create multiple experiences concurrently
      const promises = Array.from({ length: 10 }, async (_, i) => {
        const contract = new Contract({
          name: `Form ${i}`,
          elements: [
            {
              id: `input-${i}`,
              type: 'input',
              properties: { label: `Field ${i}` },
              dataBindings: [],
              eventBindings: [],
              children: []
            }
          ],
          operations: []
        });

        await editorService.initializeExperience(`form-${i}`, contract);
        return editorService.getCurrentContract(`form-${i}`);
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(10);
      expect(results.every(contract => contract !== null)).toBe(true);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should handle large edit histories efficiently', async () => {
      const contract = new Contract({
        name: 'Performance Test',
        elements: [
          {
            id: 'counter',
            type: 'text',
            properties: { text: '0' },
            dataBindings: [],
            eventBindings: [],
            children: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('perf-test', contract);

      const startTime = Date.now();
      
      // Apply 100 edits
      for (let i = 0; i < 100; i++) {
        const edit = {
          id: `edit-${i}`,
          type: 'property-change' as const,
          timestamp: new Date(),
          elementId: 'counter',
          property: 'text',
          oldValue: i.toString(),
          newValue: (i + 1).toString(),
          userId: 'user-1'
        };

        await editorService.applyEdit('perf-test', edit);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      const history = await editorService.getEditHistory('perf-test');
      expect(history).toHaveLength(100);
      expect(duration).toBeLessThan(500); // Should complete within 500ms
    });
  });

  describe('Error Handling', () => {
    it('should handle missing elements gracefully', async () => {
      const contract = new Contract({
        name: 'Test Form',
        elements: [],
        operations: []
      });

      await editorService.initializeExperience('error-test', contract);

      const edit = {
        id: 'edit-1',
        type: 'property-change' as const,
        timestamp: new Date(),
        elementId: 'non-existent',
        property: 'text',
        oldValue: 'old',
        newValue: 'new',
        userId: 'user-1'
      };

      await expect(editorService.applyEdit('error-test', edit))
        .rejects.toThrow('Element non-existent not found');
    });

    it('should handle invalid experience IDs', async () => {
      const contract = await editorService.getCurrentContract('non-existent');
      expect(contract).toBeNull();

      const history = await editorService.getEditHistory('non-existent');
      expect(history).toHaveLength(0);
    });
  });
});
