/**
 * Integration Tests: Component Integration and Operation Binding
 * Exercises the real runtime conventions end to end:
 * - state seeds from contract.initialState plus operation output placeholders;
 * - controlled inputs write their value into state under `element_${id}`;
 * - operations execute per executionType (builtin operations run the real
 *   registry functions) and results mirror at `operation_${opId}`;
 * - list elements repeat their children per bound item and event handlers
 *   receive the current item as event context.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentRenderer } from '../../components/runtime/ComponentRenderer';
import { OperationExecutor, OperationResolutionError } from '../../components/runtime/OperationExecutor';
import { ExperienceStateManager } from '../../components/runtime/ExperienceStateManager';
import { DynamicExperienceRenderer } from '../../components/runtime/DynamicExperienceRenderer';
import { Contract as ContractModel } from '../../models/contract';
import { SAMPLE_TODO_CONTRACT } from '../../test/llm-mocks';
import { installInvokeMock, invokeMock } from '../support/tauri-invoke-mock';
import type { Contract, OperationBinding, UIElement } from '../../types/contract';
import type { ExperienceState } from '../../types/experience';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

function emptyState(): ExperienceState {
  return { data: {}, loading: {}, errors: {}, lastUpdated: new Date() };
}

describe('Component Integration and Operation Binding', () => {
  let componentRenderer: ComponentRenderer;
  let operationExecutor: OperationExecutor;
  let stateManager: ExperienceStateManager;

  beforeEach(() => {
    installInvokeMock();
    // TauriCommandService only calls invoke when it detects a Tauri window;
    // flag one so remote operations exercise the mocked execute_operation
    // command instead of the service's own offline fallback.
    (window as any).__TAURI__ = {};
    componentRenderer = new ComponentRenderer();
    operationExecutor = new OperationExecutor();
    stateManager = new ExperienceStateManager('test-experience');
  });

  describe('Experience State Initialization', () => {
    it('seeds declared initial state, operation placeholders, and element defaults', async () => {
      const contract = {
        name: 'seeded-app',
        version: '1.0.0',
        initialState: { todos: [], filter: 'all' },
        elements: [
          {
            id: 'entry',
            type: 'input',
            properties: { defaultValue: 'seed text' },
            dataBindings: [],
            eventBindings: [],
          },
        ],
        operations: [
          {
            id: 'op-1',
            operationName: 'todos.add',
            executionType: 'builtin',
            inputs: [],
            outputs: [{ name: 'todos', target: 'state', targetId: 'todos' }],
            triggers: [],
          },
        ],
        layout: { type: 'flex', properties: {} },
        styling: { theme: 'default' },
        metadata: { createdAt: new Date(), updatedAt: new Date(), version: '1.0.0' },
      } as unknown as Contract;

      const state = await stateManager.initializeState(contract);

      // Declared app state
      expect(state.data.todos).toEqual([]);
      expect(state.data.filter).toBe('all');
      // Operation output placeholder and loading flag
      expect(state.data['operation_op-1_todos']).toBeNull();
      expect(state.loading['op-1']).toBe(false);
      // Element default value lands under element_${id}
      expect(state.data['element_entry']).toBe('seed text');
    });

    it('mirrors operation results and routes outputs to state and elements', () => {
      stateManager.updateStateFromOperationResult('op-1', { result: 42, extra: 'echo' }, [
        { name: 'result', target: 'state', targetId: 'total' },
        { name: 'extra', target: 'ui-element', targetId: 'field' },
      ]);

      // Whole result mirrors under operation_${opId}
      expect(stateManager.getData('operation_op-1')).toEqual({ result: 42, extra: 'echo' });
      // Outputs route per their targets
      expect(stateManager.getData('total')).toBe(42);
      expect(stateManager.getData('element_field')).toBe('echo');
      // Per-output raw values are also stored
      expect(stateManager.getData('operation_op-1_result')).toBe(42);
      expect(stateManager.getData('operation_op-1_extra')).toBe('echo');
    });

    it('notifies subscribers on state changes', () => {
      const callback = vi.fn();
      const unsubscribe = stateManager.subscribeToStateChanges(callback);

      stateManager.setData('a', 1);
      stateManager.setData('b', 2);
      expect(callback).toHaveBeenCalledTimes(2);

      unsubscribe();
      stateManager.setData('c', 3);
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('Operation Execution', () => {
    it('runs builtin todos.add against real registry code and mutates the todos state', async () => {
      stateManager.setData('todos', []);
      stateManager.setData('element_todo-input', 'Buy milk');

      const operation: OperationBinding = {
        id: 'op-add',
        operationName: 'todos.add',
        executionType: 'builtin',
        inputs: [{ name: 'title', source: 'ui-element', sourceId: 'todo-input' }],
        outputs: [],
        triggers: [],
      };

      const result = await operationExecutor.executeOperation(operation, {}, stateManager);

      expect((result.todos as unknown[]).length).toBe(1);
      const todos = stateManager.getData('todos') as Array<{ title: string; completed: boolean }>;
      expect(todos).toHaveLength(1);
      expect(todos[0].title).toBe('Buy milk');
      expect(todos[0].completed).toBe(false);
      expect(result.reset).toBe('');
    });

    it('runs builtin todos.toggle with the item event context from a list row', async () => {
      const todo = { id: 't-1', title: 'Existing', completed: false };
      stateManager.setData('todos', [todo]);

      const operation: OperationBinding = {
        id: 'op-toggle',
        operationName: 'todos.toggle',
        executionType: 'builtin',
        inputs: [{ name: 'id', source: 'item', sourceId: 'id' }],
        outputs: [],
        triggers: [],
      };

      await operationExecutor.executeOperation(operation, { item: todo }, stateManager);

      const todos = stateManager.getData('todos') as Array<{ completed: boolean }>;
      expect(todos[0].completed).toBe(true);
    });

    it('resolves constant and state input sources', async () => {
      stateManager.setData('offset', 10);

      const operation: OperationBinding = {
        id: 'op-sum',
        operationName: 'math.add',
        executionType: 'builtin',
        inputs: [
          { name: 'a', source: 'constant', sourceId: '32' },
          { name: 'b', source: 'state', sourceId: 'offset' },
        ],
        outputs: [],
        triggers: [],
      };

      const result = await operationExecutor.executeOperation(operation, {}, stateManager);
      expect(result.result).toBe(42);
    });

    it('executes local operations from their implementation code with state access', async () => {
      stateManager.setData('count', 5);

      const operation: OperationBinding = {
        id: 'op-local',
        operationName: 'custom.increment',
        executionType: 'local',
        inputs: [{ name: 'step', source: 'constant', sourceId: '3' }],
        outputs: [],
        triggers: [],
        implementation: {
          type: 'local',
          code: 'const next = Number(ctx.getState("count")) + Number(inputs.step); ctx.setState("count", next); return { next };',
        },
      };

      const result = await operationExecutor.executeOperation(operation, {}, stateManager);

      expect(result.next).toBe(8);
      expect(stateManager.getData('count')).toBe(8);
    });

    it('executes remote operations through the execute_operation command', async () => {
      installInvokeMock({
        onCommand: (cmd) =>
          cmd === 'execute_operation' ? { success: true, data: { temperature: 18 } } : undefined,
      });

      const operation: OperationBinding = {
        id: 'op-remote',
        operationName: 'weather.fetch',
        executionType: 'remote',
        inputs: [{ name: 'city', source: 'constant', sourceId: 'Oslo' }],
        outputs: [],
        triggers: [],
        implementation: { type: 'remote', endpoint: 'https://api.example.com/weather', method: 'GET' },
      };

      const result = await operationExecutor.executeOperation(operation, {}, stateManager);

      expect(result).toEqual({ temperature: 18 });
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'execute_operation');
      expect(call).toBeDefined();
      expect((call?.[1] as any).request.inputs).toEqual({ city: 'Oslo' });
    });

    it('propagates remote operation failures', async () => {
      installInvokeMock({
        onCommand: (cmd) =>
          cmd === 'execute_operation' ? { success: false, error: 'upstream 500' } : undefined,
      });

      const operation: OperationBinding = {
        id: 'op-remote',
        operationName: 'weather.fetch',
        executionType: 'remote',
        inputs: [],
        outputs: [],
        triggers: [],
        implementation: { type: 'remote', endpoint: 'https://api.example.com/weather' },
      };

      await expect(
        operationExecutor.executeOperation(operation, {}, stateManager)
      ).rejects.toThrow('Remote operation failed: upstream 500');
    });

    it('rejects operations that resolve to no runnable implementation', async () => {
      const operation: OperationBinding = {
        id: 'op-mystery',
        operationName: 'does.not.exist',
        inputs: [],
        outputs: [],
        triggers: [],
      };

      await expect(
        operationExecutor.executeOperation(operation, {}, stateManager)
      ).rejects.toThrow(OperationResolutionError);
    });
  });

  describe('Component Rendering Conventions', () => {
    it('auto-controls input elements: value reads from state and changes write back', () => {
      const setElementValue = vi.fn();
      const element: UIElement = {
        id: 'note-input',
        type: 'input',
        properties: { placeholder: 'Note' },
        dataBindings: [],
        eventBindings: [],
      };

      const state = emptyState();
      state.data['element_note-input'] = 'from state';

      const Rendered = componentRenderer.renderUIElement(element, state, vi.fn(), {
        setElementValue,
      });
      render(React.createElement(Rendered));

      const input = screen.getByPlaceholderText('Note') as HTMLInputElement;
      expect(input.value).toBe('from state');

      fireEvent.change(input, { target: { value: 'updated text' } });
      expect(setElementValue).toHaveBeenCalledWith('note-input', 'updated text');
    });

    it('repeats list children per bound item and passes the item as event context', async () => {
      const onOperationExecute = vi.fn().mockResolvedValue(undefined);
      const element: UIElement = {
        id: 'rows',
        type: 'list',
        properties: {},
        dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
        eventBindings: [],
        children: [
          {
            id: 'row-title',
            type: 'text',
            properties: {},
            dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
            eventBindings: [],
          },
          {
            id: 'row-remove',
            type: 'button',
            properties: { text: 'Remove' },
            dataBindings: [],
            eventBindings: [{ event: 'click', operationId: 'op-remove' }],
          },
        ],
      };

      const state = emptyState();
      const second = { id: 'b', title: 'Second' };
      state.data.todos = [{ id: 'a', title: 'First' }, second];

      const Rendered = componentRenderer.renderUIElement(element, state, onOperationExecute, {});
      render(React.createElement(Rendered));

      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      const removeButtons = screen.getAllByText('Remove');
      expect(removeButtons).toHaveLength(2);

      fireEvent.click(removeButtons[1]);
      await waitFor(() => {
        expect(onOperationExecute).toHaveBeenCalledWith('op-remove', { item: second });
      });
    });

    it('renders unknown element types with a visible fallback', () => {
      const element: UIElement = {
        id: 'mystery',
        type: 'holo-panel',
        properties: {},
        dataBindings: [],
        eventBindings: [],
      };

      const Rendered = componentRenderer.renderUIElement(element, emptyState(), vi.fn(), {});
      render(React.createElement(Rendered));

      expect(screen.getByText(/Unknown Component: holo-panel/)).toBeInTheDocument();
    });
  });

  describe('Full Runtime Interaction', () => {
    it('runs the generated todo contract end to end: type, add, and toggle', async () => {
      const contract = ContractModel.fromObject(SAMPLE_TODO_CONTRACT) as unknown as Contract;

      let latestState: ExperienceState | null = null;
      render(
        React.createElement(DynamicExperienceRenderer, {
          contract,
          experienceId: 'runtime-exp',
          onStateChange: (state: ExperienceState) => {
            latestState = state;
          },
        })
      );

      // Initial state seeds and renders the empty list
      await waitFor(() => {
        expect(screen.getByPlaceholderText('What needs doing?')).toBeInTheDocument();
      });
      expect(latestState?.data.todos).toEqual([]);

      // Typing writes the input value into state under element_${id}
      const input = screen.getByPlaceholderText('What needs doing?') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Buy milk' } });
      expect(latestState?.data['element_todo-input']).toBe('Buy milk');

      // Clicking Add runs the builtin todos.add operation and the list updates
      fireEvent.click(screen.getByText('Add'));
      await waitFor(() => {
        expect(screen.getByText('Buy milk')).toBeInTheDocument();
      });

      const todosAfterAdd = latestState?.data.todos as Array<{ title: string; completed: boolean }>;
      expect(todosAfterAdd).toHaveLength(1);
      expect(todosAfterAdd[0].title).toBe('Buy milk');
      // The operation result mirrors under operation_${opId}
      expect(latestState?.data['operation_op-add']).toBeDefined();
      // The declared reset output routed back into the entry input; the
      // element tree remounts on state changes, so query the input fresh.
      expect(latestState?.data['element_todo-input']).toBe('');
      const inputAfterAdd = screen.getByPlaceholderText('What needs doing?') as HTMLInputElement;
      expect(inputAfterAdd.value).toBe('');

      // Clicking the row button runs todos.toggle with the row item as context
      fireEvent.click(screen.getByText('Done'));
      await waitFor(() => {
        const todos = latestState?.data.todos as Array<{ completed: boolean }>;
        expect(todos[0].completed).toBe(true);
      });
    });
  });
});
