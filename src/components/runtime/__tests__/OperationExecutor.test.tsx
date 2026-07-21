/**
 * Tests for the Operation Executor. Covers strict executionType dispatch,
 * declarative input resolution, builtin registry execution, local code
 * execution with a timeout, and the remote path through the Tauri command
 * service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OperationExecutor, OperationResolutionError, StateAccess } from '../OperationExecutor';
import { OperationBinding } from '../../../types/contract';
import { tauriCommandService } from '../../../services/tauri/TauriCommandService';
import { invoke } from '@tauri-apps/api/core';
import type { TodoItem } from '../../../services/operations/registry';

vi.mock('../../../services/tauri/TauriCommandService', () => ({
  tauriCommandService: {
    executeOperation: vi.fn()
  }
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

const mockExecuteOperation = vi.mocked(tauriCommandService.executeOperation);
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

interface TestState extends StateAccess {
  data: Record<string, unknown>;
}

function makeState(initial: Record<string, unknown> = {}): TestState {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    getData: vi.fn((key: string) => data[key]),
    setData: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    })
  };
}

function makeOperation(overrides: Partial<OperationBinding> = {}): OperationBinding {
  return {
    id: 'op-test',
    operationName: 'test.operation',
    inputs: [],
    outputs: [],
    triggers: [],
    ...overrides
  };
}

describe('OperationExecutor', () => {
  let executor: OperationExecutor;

  beforeEach(() => {
    executor = new OperationExecutor();
    vi.clearAllMocks();
  });

  describe('builtin operations', () => {
    it('runs todos.add against the todos state array', async () => {
      const state = makeState({ todos: [], 'element_new-todo': '  Buy milk  ' });
      const operation = makeOperation({
        id: 'op-add',
        operationName: 'todos.add',
        executionType: 'builtin',
        inputs: [{ name: 'title', source: 'ui-element', sourceId: 'new-todo' }]
      });

      const result = await executor.executeOperation(operation, {}, state);

      const todos = result.todos as TodoItem[];
      expect(todos).toHaveLength(1);
      expect(todos[0].title).toBe('Buy milk');
      expect(todos[0].completed).toBe(false);
      expect(typeof todos[0].id).toBe('string');
      expect(todos[0].id.length).toBeGreaterThan(0);
      expect(result.todo).toEqual(todos[0]);
      expect(result.reset).toBe('');
      expect(state.setData).toHaveBeenCalledWith('todos', todos);
      expect(state.data.todos).toEqual(todos);
    });

    it('returns without writing state when todos.add gets an empty title', async () => {
      const existing = [{ id: 't1', title: 'Keep me', completed: false }];
      const state = makeState({ todos: existing, element_entry: '   ' });
      const operation = makeOperation({
        id: 'op-add',
        operationName: 'todos.add',
        executionType: 'builtin',
        inputs: [{ name: 'title', source: 'ui-element', sourceId: 'entry' }]
      });

      const result = await executor.executeOperation(operation, {}, state);

      expect(result).toEqual({ todos: existing, todo: null, reset: '' });
      expect(state.setData).not.toHaveBeenCalled();
    });

    it('runs todos.toggle to flip completion by id', async () => {
      const state = makeState({
        todos: [
          { id: 't1', title: 'First', completed: false },
          { id: 't2', title: 'Second', completed: true }
        ]
      });
      const operation = makeOperation({
        id: 'op-toggle',
        operationName: 'todos.toggle',
        executionType: 'builtin',
        inputs: [{ name: 'id', source: 'constant', sourceId: 't1' }]
      });

      const result = await executor.executeOperation(operation, {}, state);

      expect(result.todos).toEqual([
        { id: 't1', title: 'First', completed: true },
        { id: 't2', title: 'Second', completed: true }
      ]);
      expect(state.data.todos).toEqual(result.todos);
    });

    it('runs todos.remove with an id taken from the event item', async () => {
      const state = makeState({
        todos: [
          { id: 't1', title: 'First', completed: false },
          { id: 't2', title: 'Second', completed: false }
        ]
      });
      const operation = makeOperation({
        id: 'op-remove',
        operationName: 'todos.remove',
        executionType: 'builtin',
        inputs: [{ name: 'id', source: 'item', sourceId: 'id' }]
      });

      const result = await executor.executeOperation(operation, { item: { id: 't2' } }, state);

      expect(result.todos).toEqual([{ id: 't1', title: 'First', completed: false }]);
      expect(state.data.todos).toEqual(result.todos);
    });

    it('runs math.add as a pure computation', async () => {
      const state = makeState({ first: 2 });
      const operation = makeOperation({
        id: 'op-sum',
        operationName: 'math.add',
        executionType: 'builtin',
        inputs: [
          { name: 'a', source: 'state', sourceId: 'first' },
          { name: 'b', source: 'constant', sourceId: '3' }
        ]
      });

      const result = await executor.executeOperation(operation, {}, state);

      expect(result).toEqual({ result: 5 });
      expect(state.setData).not.toHaveBeenCalled();
    });

    it('runs http.get through the Tauri execute_operation command', async () => {
      mockInvoke.mockResolvedValue({ success: true, data: { items: [1, 2] } });
      const operation = makeOperation({
        id: 'op-fetch',
        operationName: 'http.get',
        executionType: 'builtin',
        inputs: [{ name: 'url', source: 'constant', sourceId: 'https://example.com/data.json' }]
      });

      const result = await executor.executeOperation(operation, {}, makeState());

      expect(result).toEqual({ response: { items: [1, 2] } });
      expect(mockInvoke).toHaveBeenCalledWith('execute_operation', {
        request: expect.objectContaining({
          operation_type: 'remote',
          implementation: expect.objectContaining({
            endpoint: 'https://example.com/data.json',
            method: 'GET'
          })
        })
      });
    });

    it('rejects when an explicit builtin name is not registered', async () => {
      const operation = makeOperation({
        operationName: 'nope.missing',
        executionType: 'builtin'
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        OperationResolutionError
      );
    });
  });

  describe('input resolution', () => {
    it('resolves all four input sources', () => {
      const state = makeState({ element_field: 'typed text', count: 7 });
      const operation = makeOperation({
        inputs: [
          { name: 'fromElement', source: 'ui-element', sourceId: 'field' },
          { name: 'fromState', source: 'state', sourceId: 'count' },
          { name: 'fromConstant', source: 'constant', sourceId: 'literal value' },
          { name: 'fromItem', source: 'item', sourceId: 'user.name' }
        ]
      });
      const eventContext = { item: { user: { name: 'Ada' } } };

      const inputs = executor.resolveInputs(operation, eventContext, state);

      expect(inputs).toEqual({
        fromElement: 'typed text',
        fromState: 7,
        fromConstant: 'literal value',
        fromItem: 'Ada'
      });
      expect(state.getData).toHaveBeenCalledWith('element_field');
      expect(state.getData).toHaveBeenCalledWith('count');
    });

    it('resolves an empty item path to the whole item', () => {
      const item = { id: 't1', title: 'First' };
      const operation = makeOperation({
        inputs: [{ name: 'entry', source: 'item', sourceId: '' }]
      });

      const inputs = executor.resolveInputs(operation, { item }, makeState());

      expect(inputs.entry).toBe(item);
    });

    it('resolves missing item paths to undefined', () => {
      const operation = makeOperation({
        inputs: [{ name: 'missing', source: 'item', sourceId: 'not.there' }]
      });

      const inputs = executor.resolveInputs(operation, { item: { id: 1 } }, makeState());

      expect(inputs.missing).toBeUndefined();
    });

    it('applies transforms to resolved values', () => {
      const operation = makeOperation({
        inputs: [
          {
            name: 'greeting',
            source: 'constant',
            sourceId: 'world',
            transform: { type: 'format', parameters: { template: 'Hello {{value}}' } }
          }
        ]
      });

      const inputs = executor.resolveInputs(operation, {}, makeState());

      expect(inputs.greeting).toBe('Hello world');
    });
  });

  describe('local operations', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs implementation code with inputs and state context', async () => {
      const state = makeState({ counter: 1 });
      const operation = makeOperation({
        id: 'op-local',
        executionType: 'local',
        inputs: [{ name: 'amount', source: 'state', sourceId: 'counter' }],
        implementation: {
          type: 'local',
          code: 'var next = Number(inputs.amount) + 1; ctx.setState("counter", next); return { counter: next };'
        }
      });

      const result = await executor.executeOperation(operation, {}, state);

      expect(result).toEqual({ counter: 2 });
      expect(state.data.counter).toBe(2);
    });

    it('rejects local code that returns a non-object', async () => {
      const operation = makeOperation({
        id: 'op-scalar',
        executionType: 'local',
        implementation: { type: 'local', code: 'return 42;' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'must return an object keyed by output names'
      );
    });

    it('rejects local code that returns an array', async () => {
      const operation = makeOperation({
        id: 'op-array',
        executionType: 'local',
        implementation: { type: 'local', code: 'return [1, 2];' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'must return an object keyed by output names'
      );
    });

    it('surfaces errors thrown by local code', async () => {
      const operation = makeOperation({
        id: 'op-throws',
        executionType: 'local',
        implementation: { type: 'local', code: 'throw new Error("boom");' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow('boom');
    });

    it('rejects code that does not compile', async () => {
      const operation = makeOperation({
        id: 'op-broken',
        executionType: 'local',
        implementation: { type: 'local', code: 'this is not javascript' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'has invalid code'
      );
    });

    it('rejects a local operation without code', async () => {
      const operation = makeOperation({ id: 'op-empty', executionType: 'local' });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'has no code'
      );
    });

    it('times out local code that never settles', async () => {
      const operation = makeOperation({
        id: 'op-hang',
        executionType: 'local',
        implementation: { type: 'local', code: 'return new Promise(function () {});' }
      });

      const pending = executor.executeOperation(operation, {}, makeState());
      const expectation = expect(pending).rejects.toThrow('timed out after 5000ms');
      await vi.advanceTimersByTimeAsync(5000);
      await expectation;
    });
  });

  describe('remote operations', () => {
    it('sends the declared endpoint, method, and headers to the backend', async () => {
      mockExecuteOperation.mockResolvedValue({
        success: true,
        data: { items: ['a'] },
        execution_time_ms: 12
      });
      const state = makeState({ element_query: 'shoes' });
      const operation = makeOperation({
        id: 'op-search',
        operationName: 'searchItems',
        executionType: 'remote',
        inputs: [{ name: 'query', source: 'ui-element', sourceId: 'query' }],
        implementation: {
          type: 'remote',
          endpoint: 'https://api.example.com/search',
          method: 'POST',
          headers: { 'X-Token': 'abc' }
        }
      });

      const result = await executor.executeOperation(operation, {}, state);

      expect(mockExecuteOperation).toHaveBeenCalledWith({
        operation_id: 'op-search',
        operation_name: 'searchItems',
        operation_type: 'remote',
        inputs: { query: 'shoes' },
        implementation: {
          type: 'remote',
          endpoint: 'https://api.example.com/search',
          method: 'POST',
          headers: { 'X-Token': 'abc' }
        }
      });
      expect(result).toEqual({ items: ['a'] });
    });

    it('defaults the method to GET and the headers to an empty object', async () => {
      mockExecuteOperation.mockResolvedValue({ success: true, data: {}, execution_time_ms: 1 });
      const operation = makeOperation({
        id: 'op-plain',
        executionType: 'remote',
        implementation: { type: 'remote', endpoint: 'https://api.example.com/plain' }
      });

      await executor.executeOperation(operation, {}, makeState());

      expect(mockExecuteOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          implementation: {
            type: 'remote',
            endpoint: 'https://api.example.com/plain',
            method: 'GET',
            headers: {}
          }
        })
      );
    });

    it('wraps non-object response data under a response key', async () => {
      const operation = makeOperation({
        id: 'op-text',
        executionType: 'remote',
        implementation: { type: 'remote', endpoint: 'https://api.example.com/text' }
      });

      mockExecuteOperation.mockResolvedValueOnce({
        success: true,
        data: 'plain text',
        execution_time_ms: 1
      });
      expect(await executor.executeOperation(operation, {}, makeState())).toEqual({
        response: 'plain text'
      });

      mockExecuteOperation.mockResolvedValueOnce({ success: true, data: [1, 2], execution_time_ms: 1 });
      expect(await executor.executeOperation(operation, {}, makeState())).toEqual({
        response: [1, 2]
      });
    });

    it('throws when the backend reports failure', async () => {
      mockExecuteOperation.mockResolvedValue({
        success: false,
        error: 'network down',
        execution_time_ms: 3
      });
      const operation = makeOperation({
        id: 'op-fail',
        executionType: 'remote',
        implementation: { type: 'remote', endpoint: 'https://api.example.com/fail' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'Remote operation failed: network down'
      );
    });

    it('reports an unknown error when the backend gives none', async () => {
      mockExecuteOperation.mockResolvedValue({ success: false, execution_time_ms: 3 });
      const operation = makeOperation({
        id: 'op-vague',
        executionType: 'remote',
        implementation: { type: 'remote', endpoint: 'https://api.example.com/vague' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'Remote operation failed: Unknown error'
      );
    });

    it('lets transport errors from the command service propagate', async () => {
      mockExecuteOperation.mockRejectedValue(new Error('ipc failed'));
      const operation = makeOperation({
        id: 'op-transport',
        executionType: 'remote',
        implementation: { type: 'remote', endpoint: 'https://api.example.com/down' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'ipc failed'
      );
    });

    it('rejects a remote operation without an endpoint', async () => {
      const operation = makeOperation({
        id: 'op-nowhere',
        executionType: 'remote',
        implementation: { type: 'remote' }
      });

      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toThrow(
        'has no endpoint'
      );
    });
  });

  describe('execution type resolution', () => {
    it('defaults registry names to builtin when executionType is missing', () => {
      const operation = makeOperation({ operationName: 'math.add' });
      expect(executor.resolveExecutionType(operation)).toBe('builtin');
    });

    it('defaults operations with code to local when executionType is missing', () => {
      const operation = makeOperation({
        operationName: 'custom.compute',
        implementation: { type: 'local', code: 'return {};' }
      });
      expect(executor.resolveExecutionType(operation)).toBe('local');
    });

    it('defaults operations with an endpoint to remote when executionType is missing', () => {
      const operation = makeOperation({
        operationName: 'custom.fetch',
        implementation: { type: 'remote', endpoint: 'https://api.example.com' }
      });
      expect(executor.resolveExecutionType(operation)).toBe('remote');
    });

    it('throws OperationResolutionError when nothing can run the operation', () => {
      const operation = makeOperation({ id: 'op-unknown', operationName: 'mystery.op' });
      expect(() => executor.resolveExecutionType(operation)).toThrow(OperationResolutionError);
      expect(() => executor.resolveExecutionType(operation)).toThrow('mystery.op');
      expect(() => executor.resolveExecutionType(operation)).toThrow('op-unknown');
    });

    it('rejects executeOperation with OperationResolutionError for unknown operations', async () => {
      const operation = makeOperation({ operationName: 'mystery.op' });
      await expect(executor.executeOperation(operation, {}, makeState())).rejects.toBeInstanceOf(
        OperationResolutionError
      );
    });

    it('tolerates legacy repository operations whose name is a builtin', async () => {
      const state = makeState({ todos: [{ id: 't1', title: 'Old', completed: false }] });
      const operation = makeOperation({
        id: 'op-legacy',
        operationName: 'todos.remove',
        executionType: 'repository',
        inputs: [{ name: 'id', source: 'constant', sourceId: 't1' }]
      });

      const result = await executor.executeOperation(operation, {}, state);

      expect(result.todos).toEqual([]);
      expect(state.data.todos).toEqual([]);
    });

    it('rejects legacy repository operations with no builtin counterpart', () => {
      const operation = makeOperation({
        operationName: 'repo.custom',
        executionType: 'repository'
      });
      expect(() => executor.resolveExecutionType(operation)).toThrow(OperationResolutionError);
    });
  });
});
