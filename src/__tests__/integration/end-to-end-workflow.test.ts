/**
 * End-to-End Workflow Integration Test
 * Tests the complete workflow from natural language to rendered experience.
 * Generation is LLM-backed: the Tauri `llm_chat` command is mocked and routed
 * through the shared llm-mocks fixtures.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Blueprint } from '../../models/blueprint';
import { Contract } from '../../models/contract';
import { SAMPLE_TODO_CONTRACT } from '../../test/llm-mocks';
import { installInvokeMock, invokeMock } from '../support/tauri-invoke-mock';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// The SQL plugin is an external package, so its internal import of the Tauri
// core module bypasses the mock above; stub the database handle directly.

describe('End-to-End Workflow Integration', () => {
  let integratedService: IntegratedExperienceService;

  beforeEach(() => {
    installInvokeMock();
    integratedService = new IntegratedExperienceService();
  });

  describe('Natural Language to Rendered Experience', () => {
    it('should complete the full workflow from natural language input to rendered experience', async () => {
      const naturalLanguageInput =
        'Create a todo list app where users can add tasks and mark them as complete';

      const result = await integratedService.createExperienceFromNaturalLanguage(
        naturalLanguageInput,
        {
          preserveEdits: true,
          autoSave: true,
          enableRealTimeUpdates: true,
        }
      );

      // Result structure
      expect(result).toHaveProperty('experienceId');
      expect(result).toHaveProperty('blueprint');
      expect(result).toHaveProperty('contract');
      expect(result).toHaveProperty('experience');
      expect(result).toHaveProperty('renderComponent');

      expect(result.experienceId).toMatch(/^exp-\d+-[a-z0-9]+$/);

      // Blueprint comes from the mocked intent extraction
      expect(result.blueprint).toBeInstanceOf(Blueprint);
      expect(result.blueprint.goal).toBe('Create a todo list app');
      expect(result.blueprint.uiElements).toHaveLength(3);

      // Contract comes from the mocked contract generation
      expect(result.contract).toBeInstanceOf(Contract);
      expect(result.contract.elements).toHaveLength(SAMPLE_TODO_CONTRACT.elements.length);
      expect(result.contract.operations).toHaveLength(SAMPLE_TODO_CONTRACT.operations.length);
      expect(result.contract.operations.map((op) => op.operationName)).toEqual([
        'todos.add',
        'todos.toggle',
      ]);
      expect(result.contract.initialState).toEqual({ todos: [] });

      // Experience object
      expect(result.experience.id).toBe(result.experienceId);
      expect(result.experience.contract).toBe(result.contract);
      expect(result.experience.state).toHaveProperty('data');
      expect(result.experience.state).toHaveProperty('loading');
      expect(result.experience.state).toHaveProperty('errors');
      expect(result.experience.state.lastUpdated).toBeInstanceOf(Date);

      // React component
      expect(result.renderComponent).toBeTypeOf('function');
    });

    it('should route intent and contract generation through the llm_chat command', async () => {
      await integratedService.createExperienceFromNaturalLanguage(
        'Create a todo list app for daily planning'
      );

      const llmCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'llm_chat');
      // One call for intent extraction and one for contract generation
      expect(llmCalls.length).toBe(2);
      const systems = llmCalls.map(([, args]) => {
        const messages = (args as any)?.request?.messages ?? [];
        return messages.find((m: any) => m.role === 'system')?.content ?? '';
      });
      expect(systems.some((s: string) => s.includes('structured intent'))).toBe(true);
      expect(systems.some((s: string) => s.includes('Contract JSON'))).toBe(true);
    });

    it('should handle workflow with edit preservation', async () => {
      const input = 'Build a simple task tracker with basic operations';

      const result = await integratedService.createExperienceFromNaturalLanguage(input, {
        preserveEdits: true,
      });

      const editHistory = await integratedService.getEditHistory(result.experienceId);
      expect(Array.isArray(editHistory)).toBe(true);
    });

    it('should handle workflow with auto-save enabled', async () => {
      const input = 'Create a todo manager with search functionality';

      const result = await integratedService.createExperienceFromNaturalLanguage(input, {
        autoSave: true,
      });

      expect(result.experienceId).toBeDefined();
      expect(result.experience).toBeDefined();
      // Auto-save persists through the Tauri save_experience command
      const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_experience');
      expect(saveCalls.length).toBeGreaterThan(0);
    });

    it('should handle errors gracefully in the workflow', async () => {
      const mockError = new Error('AI service unavailable');
      vi.spyOn(integratedService['aiInterpreter'], 'parseNaturalLanguage').mockRejectedValueOnce(
        mockError
      );

      await expect(
        integratedService.createExperienceFromNaturalLanguage('Invalid input')
      ).rejects.toThrow('Failed to create experience: AI service unavailable');
    });

    it('should surface LLM failures as workflow errors', async () => {
      installInvokeMock({
        onCommand: (cmd) => {
          if (cmd === 'llm_chat') {
            throw new Error('model backend unreachable');
          }
          return undefined;
        },
      });

      await expect(
        integratedService.createExperienceFromNaturalLanguage('Create a todo list app')
      ).rejects.toThrow('Failed to create experience');
    });
  });

  describe('Experience State Management', () => {
    it('should manage experience state throughout the workflow', async () => {
      const input = 'Create a todo dashboard';
      const result = await integratedService.createExperienceFromNaturalLanguage(input);

      // Runtime state seeds from contract.initialState
      const initialState = await integratedService.getExperienceState(result.experienceId);
      expect(initialState).toBeDefined();
      expect(initialState?.lastUpdated).toBeInstanceOf(Date);
      expect(initialState?.data.todos).toEqual([]);

      await integratedService.updateExperienceState(result.experienceId, {
        data: { todos: [{ id: '1', title: 'done deal', completed: true }] },
      });

      const updatedState = await integratedService.getExperienceState(result.experienceId);
      expect(updatedState?.data.todos).toHaveLength(1);
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
      const input = 'Create a note-taking app';
      const result = await integratedService.createExperienceFromNaturalLanguage(input);

      const state = await integratedService.getExperienceState(result.experienceId);
      expect(state).toBeDefined();

      await integratedService.cleanupExperience(result.experienceId);

      const stateAfterCleanup = await integratedService.getExperienceState(result.experienceId);
      expect(stateAfterCleanup).toBeNull();
    });
  });
});
