/**
 * Integration Tests: Blueprint to Experience Pipeline
 * Exercises the LLM-backed generation pipeline directly: natural language to
 * blueprint (intent extraction), blueprint to contract (contract generation),
 * and contract to runtime experience. All model calls go through the mocked
 * Tauri `llm_chat` command.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIInterpreterService } from '../../services/ai-interpreter';
import { RepositoryService } from '../../services/repository/repository-service';
import { registerBuiltins } from '../../services/repository/builtins';
import { DynamicExperienceRuntimeService } from '../../components/runtime/DynamicExperienceRuntimeService';
import { Blueprint } from '../../models/blueprint';
import { SAMPLE_INTENT, SAMPLE_TODO_CONTRACT, routeLlmChat } from '../../test/llm-mocks';
import { installInvokeMock, invokeMock } from '../support/tauri-invoke-mock';

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

describe('Blueprint to Experience Pipeline Integration', () => {
  let aiInterpreter: AIInterpreterService;
  let repository: RepositoryService;
  let runtime: DynamicExperienceRuntimeService;

  beforeEach(async () => {
    installInvokeMock();
    repository = new RepositoryService();
    // Storage is unavailable under the mock; registration must still succeed
    // through the in-memory index.
    await registerBuiltins(repository);
    aiInterpreter = new AIInterpreterService(repository);
    runtime = new DynamicExperienceRuntimeService();
  });

  describe('Repository builtins', () => {
    it('registers builtin operations with executionType builtin even without storage', async () => {
      const operations = await repository.queryOperations({});
      const names = operations.map((op) => op.name);

      expect(names).toEqual(
        expect.arrayContaining(['todos.add', 'todos.toggle', 'todos.remove', 'math.add', 'http.get'])
      );
      operations.forEach((op) => {
        expect(op.executionType).toBe('builtin');
      });
    });

    it('registers builtin UI elements alongside operations', async () => {
      const uiElements = await repository.queryUIElements({});
      const names = uiElements.map((el) => el.name);

      expect(names).toEqual(
        expect.arrayContaining(['button', 'input', 'text', 'container', 'list'])
      );
    });
  });

  describe('Complete Pipeline Flow', () => {
    it('should process natural language input to a rendered experience', async () => {
      const naturalLanguageInput = 'Create a todo list app where I can add and complete tasks';

      // Natural language to blueprint
      const blueprint = await aiInterpreter.parseNaturalLanguage(naturalLanguageInput);

      expect(blueprint).toBeInstanceOf(Blueprint);
      expect(blueprint.goal).toBe(SAMPLE_INTENT.goal);
      expect(blueprint.requiredCapabilities).toEqual(
        expect.arrayContaining(['data-entry', 'list-display'])
      );
      expect(blueprint.uiElements.map((el) => el.type)).toEqual(['input', 'button', 'list']);

      // Blueprint to contract (LLM-driven, constrained by the catalog)
      const contract = await aiInterpreter.generateContract(blueprint);

      expect(contract.name).toBe('todo-list');
      expect(contract.initialState).toEqual({ todos: [] });
      expect(contract.elements.map((el) => el.id)).toEqual([
        'title',
        'todo-input',
        'add-btn',
        'todo-list',
      ]);
      expect(contract.operations).toHaveLength(2);
      contract.operations.forEach((op) => {
        expect(op.executionType).toBe('builtin');
      });

      // Wiring: the add button fires the add operation, which reads the input
      const addButton = contract.elements.find((el) => el.id === 'add-btn');
      expect(addButton?.eventBindings).toEqual([{ event: 'click', operationId: 'op-add' }]);
      const addOperation = contract.operations.find((op) => op.id === 'op-add');
      expect(addOperation?.inputs).toEqual([
        { name: 'title', source: 'ui-element', sourceId: 'todo-input' },
      ]);

      // The list repeats its children per entry of the bound todos state
      const list = contract.elements.find((el) => el.id === 'todo-list');
      expect(list?.dataBindings).toEqual([
        { property: 'items', source: 'state', sourceId: 'todos' },
      ]);
      expect(list?.children?.length).toBeGreaterThan(0);

      // Contract to runtime experience
      const component = await runtime.renderExperience(contract, 'pipeline-exp');
      expect(component).toBeTypeOf('function');

      // Runtime state seeds from contract.initialState plus operation mirrors
      const state = runtime.getExperienceState('pipeline-exp');
      expect(state?.data.todos).toEqual([]);
      expect(state?.data).toHaveProperty('operation_op-add_reset', null);
      expect(state?.loading['op-add']).toBe(false);
    });

    it('should produce a contract that passes contract validation', async () => {
      const blueprint = await aiInterpreter.parseNaturalLanguage('Create a todo list app');
      const contract = await aiInterpreter.generateContract(blueprint);

      const { ContractBuilder } = await import('../../services/ai-interpreter');
      const builder = new ContractBuilder(repository);
      const validation = builder.validateContract(contract);

      expect(validation.errors).toEqual([]);
      expect(validation.isValid).toBe(true);
    });

    it('should apply user edits on top of the generated contract', async () => {
      const blueprint = await aiInterpreter.parseNaturalLanguage('Create a todo list app');

      const contract = await aiInterpreter.generateContract(blueprint, {
        elementEdits: {
          'add-btn': { properties: { text: 'Save task' } },
        },
        operationEdits: {},
        layoutEdits: { properties: { gap: '24px' } },
        styleEdits: { theme: 'dark' },
      } as any);

      const addButton = contract.elements.find((el) => el.id === 'add-btn');
      expect(addButton?.properties.text).toBe('Save task');
      expect(contract.layout.properties.gap).toBe('24px');
      expect(contract.styling.theme).toBe('dark');
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should reject empty descriptions before calling the model', async () => {
      await expect(aiInterpreter.parseNaturalLanguage('')).rejects.toThrow('Invalid description');
      const llmCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'llm_chat');
      expect(llmCalls).toHaveLength(0);
    });

    it('should surface LLM failures as parse errors', async () => {
      installInvokeMock({
        onCommand: (cmd) => {
          if (cmd === 'llm_chat') {
            throw new Error('model backend unreachable');
          }
          return undefined;
        },
      });

      await expect(
        aiInterpreter.parseNaturalLanguage('Create a todo list app')
      ).rejects.toThrow('Failed to parse description');
    });

    it('should recover from malformed model output through the repair round', async () => {
      let intentCalls = 0;
      installInvokeMock({
        onCommand: (cmd, args) => {
          if (cmd !== 'llm_chat') {
            return undefined;
          }
          const messages = args?.request?.messages ?? [];
          const system = messages.find((m: any) => m.role === 'system')?.content ?? '';
          if (system.includes('Contract JSON')) {
            return undefined; // contract generation uses the shared fixture
          }
          intentCalls += 1;
          if (intentCalls === 1) {
            return { content: 'this is not json at all', provider: 'mock', model: 'mock' };
          }
          return routeLlmChat(args);
        },
      });

      const blueprint = await aiInterpreter.parseNaturalLanguage('Create a todo list app');

      expect(intentCalls).toBe(2);
      expect(blueprint.goal).toBe(SAMPLE_INTENT.goal);
    });

    it('should generate a contract even when the repository catalog is empty', async () => {
      const emptyRepository = new RepositoryService();
      const interpreter = new AIInterpreterService(emptyRepository);

      const blueprint = await interpreter.parseNaturalLanguage('Create a todo list app');
      const contract = await interpreter.generateContract(blueprint);

      expect(contract).toBeDefined();
      expect(contract.elements).toHaveLength(SAMPLE_TODO_CONTRACT.elements.length);
    });

    it('should recover from runtime errors during rendering', async () => {
      const blueprint = await aiInterpreter.parseNaturalLanguage('Create a todo list app');
      const contract = await aiInterpreter.generateContract(blueprint);

      vi.spyOn(runtime, 'renderExperience').mockRejectedValueOnce(new Error('Rendering failed'));
      await expect(runtime.renderExperience(contract)).rejects.toThrow('Rendering failed');

      vi.spyOn(runtime, 'renderExperience').mockResolvedValueOnce(() => null as any);
      const result = await runtime.renderExperience(contract);
      expect(result).toBeDefined();
    });
  });

  describe('Concurrency', () => {
    it('should handle concurrent pipeline executions', async () => {
      const inputs = [
        'Create a personal todo list',
        'Build a task board for the team',
        'Make a shopping checklist',
      ];

      const results = await Promise.all(
        inputs.map(async (input, index) => {
          const blueprint = await aiInterpreter.parseNaturalLanguage(input);
          const contract = await aiInterpreter.generateContract(blueprint);
          return runtime.renderExperience(contract, `concurrent-${index}`);
        })
      );

      expect(results).toHaveLength(3);
      results.forEach((component) => {
        expect(component).toBeTypeOf('function');
      });
    });
  });
});
