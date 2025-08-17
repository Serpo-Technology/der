/**
 * End-to-End Workflow Integration Test
 * Tests the complete workflow from natural language to rendered experience
 * Requirements: All requirements integration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Blueprint } from '../../models/blueprint';
import { Contract } from '../../models/contract';

// Mock the LLM client to avoid external API calls
vi.mock('../../services/ai-interpreter/llm-client', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        goal: "Create a simple todo list application",
        requiredCapabilities: ["task-management", "ui-interaction"],
        uiElements: [
          {
            type: "input",
            purpose: "Add new tasks",
            capabilities: ["text-input", "validation"]
          },
          {
            type: "button",
            purpose: "Submit new task",
            capabilities: ["click-handler"]
          },
          {
            type: "list",
            purpose: "Display tasks",
            capabilities: ["data-display", "item-selection"]
          }
        ],
        operations: [
          {
            name: "addTask",
            purpose: "Add a new task to the list",
            inputs: ["taskText"],
            outputs: ["taskId"],
            executionType: "local"
          },
          {
            name: "completeTask",
            purpose: "Mark a task as completed",
            inputs: ["taskId"],
            outputs: ["success"],
            executionType: "local"
          }
        ],
        ambiguities: []
      })
    })
  }))
}));

describe('End-to-End Workflow Integration', () => {
  let integratedService: IntegratedExperienceService;

  beforeEach(() => {
    integratedService = new IntegratedExperienceService();
  });

  describe('Natural Language to Rendered Experience', () => {
    it('should complete the full workflow from natural language input to rendered experience', async () => {
      // Test input
      const naturalLanguageInput = "Create a todo list app where users can add tasks, mark them as complete, and delete them";

      // Execute the complete workflow
      const result = await integratedService.createExperienceFromNaturalLanguage(
        naturalLanguageInput,
        {
          preserveEdits: true,
          autoSave: true,
          enableRealTimeUpdates: true
        }
      );

      // Verify the result structure
      expect(result).toHaveProperty('experienceId');
      expect(result).toHaveProperty('blueprint');
      expect(result).toHaveProperty('contract');
      expect(result).toHaveProperty('experience');
      expect(result).toHaveProperty('renderComponent');

      // Verify experience ID is generated
      expect(result.experienceId).toMatch(/^exp-\d+-[a-z0-9]+$/);

      // Verify blueprint is created
      expect(result.blueprint).toBeInstanceOf(Blueprint);
      expect(result.blueprint.intent).toBe("Create a simple todo list application");

      // Verify contract is generated
      expect(result.contract).toBeInstanceOf(Contract);
      expect(result.contract.elements).toHaveLength(3); // input, button, list
      expect(result.contract.operations).toHaveLength(2); // addTask, completeTask

      // Verify experience object
      expect(result.experience.id).toBe(result.experienceId);
      expect(result.experience.contract).toBe(result.contract);
      expect(result.experience.state).toHaveProperty('data');
      expect(result.experience.state).toHaveProperty('loading');
      expect(result.experience.state).toHaveProperty('errors');
      expect(result.experience.state.lastUpdated).toBeInstanceOf(Date);

      // Verify React component is created
      expect(result.renderComponent).toBeTypeOf('function');
    });

    it('should handle workflow with edit preservation', async () => {
      const input = "Build a simple calculator with basic arithmetic operations";

      const result = await integratedService.createExperienceFromNaturalLanguage(input, {
        preserveEdits: true
      });

      // Verify editor is initialized
      const editHistory = await integratedService.getEditHistory(result.experienceId);
      expect(Array.isArray(editHistory)).toBe(true);
    });

    it('should handle workflow with auto-save enabled', async () => {
      const input = "Create a contact manager with search functionality";

      const result = await integratedService.createExperienceFromNaturalLanguage(input, {
        autoSave: true
      });

      // Verify the experience was created successfully
      expect(result.experienceId).toBeDefined();
      expect(result.experience).toBeDefined();
    });

    it('should handle errors gracefully in the workflow', async () => {
      // Mock an error in the AI interpreter
      const mockError = new Error('AI service unavailable');
      vi.spyOn(integratedService['aiInterpreter'], 'parseNaturalLanguage')
        .mockRejectedValueOnce(mockError);

      await expect(
        integratedService.createExperienceFromNaturalLanguage("Invalid input")
      ).rejects.toThrow('Failed to create experience: AI service unavailable');
    });
  });

  describe('Experience State Management', () => {
    it('should manage experience state throughout the workflow', async () => {
      const input = "Create a weather dashboard";
      const result = await integratedService.createExperienceFromNaturalLanguage(input);

      // Get initial state
      const initialState = await integratedService.getExperienceState(result.experienceId);
      expect(initialState).toBeDefined();
      expect(initialState?.lastUpdated).toBeInstanceOf(Date);

      // Update state
      await integratedService.updateExperienceState(result.experienceId, {
        data: { weather: 'sunny' }
      });

      // Verify state update
      const updatedState = await integratedService.getExperienceState(result.experienceId);
      expect(updatedState?.data).toHaveProperty('weather', 'sunny');
    });
  });

  describe('Service Health Check', () => {
    it('should report health status of all integrated services', async () => {
      const health = await integratedService.getServiceHealth();

      expect(health).toHaveProperty('aiInterpreter', true);
      expect(health).toHaveProperty('repository', true);
      expect(health).toHaveProperty('runtime', true);
      expect(health).toHaveProperty('editor', true);
      expect(health).toHaveProperty('sharing', true);
      expect(health).toHaveProperty('bookmarks', true);
      expect(health).toHaveProperty('persistence', true);
    });
  });

  describe('Resource Cleanup', () => {
    it('should clean up experience resources properly', async () => {
      const input = "Create a note-taking app";
      const result = await integratedService.createExperienceFromNaturalLanguage(input);

      // Verify experience exists
      const state = await integratedService.getExperienceState(result.experienceId);
      expect(state).toBeDefined();

      // Clean up
      await integratedService.cleanupExperience(result.experienceId);

      // Verify cleanup
      const stateAfterCleanup = await integratedService.getExperienceState(result.experienceId);
      expect(stateAfterCleanup).toBeNull();
    });
  });
});
