/**
 * Tests for Experience State Manager
 * Requirements: 3.1, 3.2, 9.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExperienceStateManager } from '../ExperienceStateManager';
import { Contract } from '../../../types/contract';

describe('ExperienceStateManager', () => {
  let stateManager: ExperienceStateManager;
  const experienceId = 'test-exp-1';

  const mockContract: Contract = {
    name: 'Test Experience',
    version: '1.0.0',
    elements: [
      {
        id: 'input1',
        type: 'input',
        properties: { defaultValue: 'initial value' },
        dataBindings: [],
        eventBindings: []
      }
    ],
    operations: [
      {
        id: 'op1',
        operationName: 'testOperation',
        inputs: [],
        outputs: [
          {
            name: 'result',
            target: 'state',
            targetId: 'operationResult'
          }
        ],
        triggers: []
      }
    ],
    layout: { type: 'flex', properties: {} },
    styling: { theme: 'default' },
    metadata: {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0'
    }
  };

  beforeEach(() => {
    stateManager = new ExperienceStateManager(experienceId);
  });

  it('initializes with empty state', () => {
    const state = stateManager.getState();
    
    expect(state.data).toEqual({});
    expect(state.loading).toEqual({});
    expect(state.errors).toEqual({});
    expect(state.lastUpdated).toBeInstanceOf(Date);
  });

  it('initializes state from contract', async () => {
    const initialState = await stateManager.initializeState(mockContract);
    
    expect(initialState.data['element_input1']).toBe('initial value');
    expect(initialState.loading['op1']).toBe(false);
    expect(initialState.data['operation_op1_result']).toBeNull();
  });

  it('updates data correctly', () => {
    stateManager.setData('testKey', 'testValue');
    
    expect(stateManager.getData('testKey')).toBe('testValue');
    
    const state = stateManager.getState();
    expect(state.data['testKey']).toBe('testValue');
  });

  it('manages loading states', () => {
    expect(stateManager.isLoading('op1')).toBe(false);
    
    stateManager.setLoading('op1', true);
    expect(stateManager.isLoading('op1')).toBe(true);
    
    stateManager.setLoading('op1', false);
    expect(stateManager.isLoading('op1')).toBe(false);
  });

  it('manages error states', () => {
    const testError = new Error('Test error');
    
    expect(stateManager.getError('op1')).toBeNull();
    
    stateManager.setError('op1', testError);
    expect(stateManager.getError('op1')).toBe(testError);
    
    stateManager.clearError('op1');
    expect(stateManager.getError('op1')).toBeNull();
  });

  it('updates state from operation results', async () => {
    await stateManager.initializeState(mockContract);
    
    const operationResult = { result: 'operation completed' };
    const outputs = mockContract.operations[0].outputs;
    
    stateManager.updateStateFromOperationResult('op1', operationResult, outputs);
    
    expect(stateManager.getData('operationResult')).toBe('operation completed');
    expect(stateManager.getData('operation_op1_result')).toBe('operation completed');
  });

  it('notifies subscribers of state changes', () => {
    const callback = vi.fn();
    const unsubscribe = stateManager.subscribeToStateChanges(callback);
    
    stateManager.setData('testKey', 'testValue');
    
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ testKey: 'testValue' })
    }));
    
    unsubscribe();
    
    // After unsubscribing, callback should not be called
    callback.mockClear();
    stateManager.setData('anotherKey', 'anotherValue');
    expect(callback).not.toHaveBeenCalled();
  });

  it('handles batch updates efficiently', () => {
    const callback = vi.fn();
    stateManager.subscribeToStateChanges(callback);
    
    stateManager.batchUpdate(() => {
      stateManager.setData('key1', 'value1');
      stateManager.setData('key2', 'value2');
      stateManager.setLoading('op1', true);
    });
    
    // Should only be called once after batch update
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        key1: 'value1',
        key2: 'value2'
      }),
      loading: expect.objectContaining({
        op1: true
      })
    }));
  });

  it('resets state correctly', () => {
    stateManager.setData('testKey', 'testValue');
    stateManager.setLoading('op1', true);
    stateManager.setError('op1', new Error('test'));
    
    stateManager.reset();
    
    const state = stateManager.getState();
    expect(state.data).toEqual({});
    expect(state.loading).toEqual({});
    expect(state.errors).toEqual({});
  });

  it('provides state snapshot for debugging', () => {
    stateManager.setData('testKey', 'testValue');
    
    const snapshot = stateManager.getStateSnapshot();
    
    expect(snapshot.experienceId).toBe(experienceId);
    expect(snapshot.state.data.testKey).toBe('testValue');
    expect(snapshot.callbackCount).toBe(0);
  });

  it('handles UI element output bindings', async () => {
    await stateManager.initializeState(mockContract);
    
    const operationResult = { result: 'new text value' };
    const outputs = [
      {
        name: 'result',
        target: 'ui-element' as const,
        targetId: 'input1',
        property: 'value'
      }
    ];
    
    stateManager.updateStateFromOperationResult('op1', operationResult, outputs);
    
    const elementData = stateManager.getData('element_input1');
    expect(elementData.value).toBe('new text value');
  });

  it('handles complex operation results', async () => {
    await stateManager.initializeState(mockContract);
    
    const complexResult = {
      result: 'primary result',
      metadata: { timestamp: '2023-01-01' },
      status: 'success'
    };
    
    const outputs = [
      {
        name: 'result',
        target: 'state' as const,
        targetId: 'primaryResult'
      }
    ];
    
    stateManager.updateStateFromOperationResult('op1', complexResult, outputs);
    
    expect(stateManager.getData('primaryResult')).toBe('primary result');
    expect(stateManager.getData('operation_op1_result')).toBe('primary result');
  });
});