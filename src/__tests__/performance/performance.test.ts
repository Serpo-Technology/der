/**
 * Performance Tests
 * Benchmarks for the local runtime paths that do not involve the LLM:
 * state initialization and fan-out, builtin operation execution, and DOM
 * rendering of large element trees. Generation latency is model-bound and
 * is not measured here.
 */

import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExperienceStateManager } from '../../components/runtime/ExperienceStateManager';
import { OperationExecutor } from '../../components/runtime/OperationExecutor';
import { ComponentRenderer } from '../../components/runtime/ComponentRenderer';
import { DynamicExperienceRenderer } from '../../components/runtime/DynamicExperienceRenderer';
import type { Contract, OperationBinding, UIElement } from '../../types/contract';
import type { ExperienceState } from '../../types/experience';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ success: true }),
}));

function baseContract(elements: UIElement[], operations: OperationBinding[] = []): Contract {
  return {
    name: 'perf-contract',
    version: '1.0.0',
    initialState: {},
    elements,
    operations,
    layout: { type: 'flex', properties: { flexDirection: 'column' } },
    styling: { theme: 'default' },
    metadata: { createdAt: new Date(), updatedAt: new Date(), version: '1.0.0' },
  } as unknown as Contract;
}

function textElements(count: number): UIElement[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `text-${i}`,
    type: 'text',
    properties: { content: `Item ${i}` },
    dataBindings: [],
    eventBindings: [],
  }));
}

describe('Performance Tests', () => {
  let stateManager: ExperienceStateManager;
  let operationExecutor: OperationExecutor;

  beforeEach(() => {
    stateManager = new ExperienceStateManager('perf-experience');
    operationExecutor = new OperationExecutor();
  });

  describe('State Initialization Performance', () => {
    it('should initialize state for a large contract quickly', async () => {
      const elements = Array.from({ length: 1000 }, (_, i) => ({
        id: `input-${i}`,
        type: 'input',
        properties: { defaultValue: `value-${i}` },
        dataBindings: [],
        eventBindings: [],
      })) as UIElement[];
      const operations = Array.from({ length: 100 }, (_, i) => ({
        id: `op-${i}`,
        operationName: 'todos.add',
        executionType: 'builtin',
        inputs: [],
        outputs: [{ name: 'todos', target: 'state', targetId: 'todos' }],
        triggers: [],
      })) as unknown as OperationBinding[];

      const contract = baseContract(elements, operations);
      (contract as any).initialState = { todos: [] };

      const start = performance.now();
      const state = await stateManager.initializeState(contract);
      const duration = performance.now() - start;

      expect(Object.keys(state.data).length).toBeGreaterThan(1000);
      expect(state.data['element_input-999']).toBe('value-999');
      expect(state.data['operation_op-99_todos']).toBeNull();
      expect(duration).toBeLessThan(500);
    });
  });

  describe('State Update Fan-out Performance', () => {
    it('should deliver rapid state updates to many subscribers quickly', () => {
      const subscriberCount = 20;
      const updateCount = 500;
      let notifications = 0;

      const unsubscribes = Array.from({ length: subscriberCount }, () =>
        stateManager.subscribeToStateChanges(() => {
          notifications += 1;
        })
      );

      const start = performance.now();
      for (let i = 0; i < updateCount; i++) {
        stateManager.setData(`field-${i % 10}`, `value-${i}`);
      }
      const duration = performance.now() - start;

      expect(notifications).toBe(subscriberCount * updateCount);
      expect(duration).toBeLessThan(1000);

      unsubscribes.forEach((unsubscribe) => unsubscribe());
    });

    it('should collapse batched updates into a single notification', () => {
      const callback = vi.fn();
      stateManager.subscribeToStateChanges(callback);

      stateManager.batchUpdate(() => {
        for (let i = 0; i < 100; i++) {
          stateManager.setData(`batched-${i}`, i);
        }
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(stateManager.getData('batched-99')).toBe(99);
    });

    it('should mirror many operation results quickly', () => {
      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        stateManager.updateStateFromOperationResult(`op-${i}`, { value: i }, [
          { name: 'value', target: 'state', targetId: `result-${i}` },
        ]);
      }
      const duration = performance.now() - start;

      expect(stateManager.getData('result-499')).toBe(499);
      expect(stateManager.getData('operation_op-499')).toEqual({ value: 499 });
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Operation Execution Performance', () => {
    it('should execute builtin operations at high throughput', async () => {
      stateManager.setData('todos', []);
      const operation: OperationBinding = {
        id: 'op-add',
        operationName: 'todos.add',
        executionType: 'builtin',
        inputs: [{ name: 'title', source: 'constant', sourceId: 'Task' }],
        outputs: [],
        triggers: [],
      };

      const runs = 300;
      const start = performance.now();
      for (let i = 0; i < runs; i++) {
        await operationExecutor.executeOperation(operation, {}, stateManager);
      }
      const duration = performance.now() - start;

      expect((stateManager.getData('todos') as unknown[]).length).toBe(runs);
      expect(duration).toBeLessThan(1500);
    });

    it('should execute concurrent builtin operations efficiently', async () => {
      const operation: OperationBinding = {
        id: 'op-sum',
        operationName: 'math.add',
        executionType: 'builtin',
        inputs: [
          { name: 'a', source: 'constant', sourceId: '20' },
          { name: 'b', source: 'constant', sourceId: '22' },
        ],
        outputs: [],
        triggers: [],
      };

      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          operationExecutor.executeOperation(operation, {}, stateManager)
        )
      );
      const duration = performance.now() - start;

      expect(results).toHaveLength(100);
      results.forEach((result) => expect(result.result).toBe(42));
      expect(duration).toBeLessThan(500);
    });
  });

  describe('Rendering Performance', () => {
    it('should render a contract with many elements within budget', async () => {
      const contract = baseContract(textElements(200));

      const start = performance.now();
      render(
        React.createElement(DynamicExperienceRenderer, {
          contract,
          experienceId: 'perf-many-elements',
        })
      );
      await waitFor(() => {
        expect(screen.getByText('Item 199')).toBeInTheDocument();
      });
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(3000);
    });

    it('should render a list with many bound items within budget', async () => {
      const items = Array.from({ length: 300 }, (_, i) => ({ id: `row-${i}`, title: `Row ${i}` }));
      const contract = baseContract([
        {
          id: 'big-list',
          type: 'list',
          properties: {},
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'rows' }],
          eventBindings: [],
          children: [
            {
              id: 'row-title',
              type: 'text',
              properties: {},
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
              eventBindings: [],
            },
          ],
        },
      ]);
      (contract as any).initialState = { rows: items };

      const start = performance.now();
      render(
        React.createElement(DynamicExperienceRenderer, {
          contract,
          experienceId: 'perf-big-list',
        })
      );
      await waitFor(() => {
        expect(screen.getByText('Row 299')).toBeInTheDocument();
      });
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(3000);
    });

    it('should re-render small element updates cheaply', () => {
      const componentRenderer = new ComponentRenderer();
      const emptyState: ExperienceState = {
        data: {},
        loading: {},
        errors: {},
        lastUpdated: new Date(),
      };

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const element: UIElement = {
          id: 'dynamic-element',
          type: 'text',
          properties: { content: `Text ${i}` },
          dataBindings: [],
          eventBindings: [],
        };
        const Rendered = componentRenderer.renderUIElement(element, emptyState, vi.fn(), {});
        render(React.createElement(Rendered));
        cleanup();
      }
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(2000);
    });
  });

  describe('Contract Processing Performance', () => {
    it('should traverse and transform large contracts quickly', () => {
      const contract = baseContract(textElements(1000));

      const start = performance.now();
      const processed = contract.elements.map((element) => ({
        ...element,
        properties: { ...element.properties, processed: true },
      }));
      const duration = performance.now() - start;

      expect(processed).toHaveLength(1000);
      expect(duration).toBeLessThan(100);
    });
  });
});
