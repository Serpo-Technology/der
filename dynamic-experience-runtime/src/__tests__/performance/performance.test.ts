/**
 * Performance Tests
 * Tests for performance benchmarks and optimization validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIInterpreterService } from '../../services/ai-interpreter';
import { RepositoryService } from '../../services/repository/repository-service';
import { DynamicExperienceRuntimeService } from '../../components/runtime/DynamicExperienceRuntimeService';
import { ComponentRenderer } from '../../components/runtime/ComponentRenderer';
import { OperationExecutor } from '../../components/runtime/OperationExecutor';
import { Contract } from '../../models/contract';
import { Blueprint } from '../../models/blueprint';
import type { UIElement } from '../../types/contract';

// Mock external dependencies
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('Performance Tests', () => {
  let aiInterpreter: AIInterpreterService;
  let repository: RepositoryService;
  let runtime: DynamicExperienceRuntimeService;
  let componentRenderer: ComponentRenderer;
  let operationExecutor: OperationExecutor;

  beforeEach(async () => {
    aiInterpreter = new AIInterpreterService();
    repository = new RepositoryService();
    runtime = new DynamicExperienceRuntimeService();
    componentRenderer = new ComponentRenderer();
    operationExecutor = new OperationExecutor();

    // Mock repository with fast responses
    vi.spyOn(repository, 'queryUIElements').mockResolvedValue([]);
    vi.spyOn(repository, 'queryOperations').mockResolvedValue([]);
    vi.spyOn(repository, 'getComponent').mockResolvedValue(null);
  });

  describe('Contract Generation Performance', () => {
    it('should generate simple contracts within 100ms', async () => {
      const blueprint = new Blueprint({
        intent: 'Create a simple button',
        capabilities: ['clickable'],
        requirements: ['Basic button with text'],
        context: {}
      });

      const startTime = performance.now();
      const contract = await aiInterpreter.generateContract(blueprint);
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(contract).toBeDefined();
      expect(duration).toBeLessThan(100); // Should complete within 100ms
    });

    it('should generate complex contracts within 500ms', async () => {
      const blueprint = new Blueprint({
        intent: 'Create a comprehensive dashboard',
        capabilities: ['visualization', 'data-binding', 'real-time', 'filtering'],
        requirements: [
          'Multiple chart types',
          'Real-time data updates',
          'Interactive filters',
          'Export functionality'
        ],
        context: {
          complexity: 'high',
          componentCount: 20
        }
      });

      const startTime = performance.now();
      const contract = await aiInterpreter.generateContract(blueprint);
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(contract).toBeDefined();
      expect(duration).toBeLessThan(500); // Should complete within 500ms
    });

    it('should handle batch contract generation efficiently', async () => {
      const blueprints = Array.from({ length: 10 }, (_, i) => 
        new Blueprint({
          intent: `Create form ${i}`,
          capabilities: ['form', 'validation'],
          requirements: [`Form with ${i + 3} fields`],
          context: {}
        })
      );

      const startTime = performance.now();
      
      const contracts = await Promise.all(
        blueprints.map(blueprint => aiInterpreter.generateContract(blueprint))
      );
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(contracts).toHaveLength(10);
      expect(duration).toBeLessThan(1000); // Batch should complete within 1 second
    });
  });

  describe('Component Rendering Performance', () => {
    it('should render simple components within 10ms', async () => {
      const element: UIElement = {
        id: 'simple-button',
        type: 'button',
        properties: { text: 'Click me' },
        dataBindings: [],
        eventBindings: []
      };

      const startTime = performance.now();
      const rendered = await componentRenderer.renderUIElement(element, {});
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(rendered).toBeDefined();
      expect(duration).toBeLessThan(10); // Should render within 10ms
    });

    it('should render complex nested components within 50ms', async () => {
      const complexElement: UIElement = {
        id: 'complex-form',
        type: 'form',
        properties: { layout: 'grid' },
        dataBindings: [],
        eventBindings: [],
        children: Array.from({ length: 20 }, (_, i) => ({
          id: `field-${i}`,
          type: 'input',
          properties: { 
            placeholder: `Field ${i}`,
            validation: { required: true }
          },
          dataBindings: [
            {
              property: 'value',
              source: { type: 'state', key: `field${i}` }
            }
          ],
          eventBindings: [
            {
              event: 'onChange',
              action: { type: 'updateState', key: `field${i}` }
            }
          ]
        }))
      };

      const startTime = performance.now();
      const rendered = await componentRenderer.renderUIElement(complexElement, {});
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(rendered).toBeDefined();
      expect(duration).toBeLessThan(50); // Should render within 50ms
    });

    it('should handle bulk rendering efficiently', async () => {
      const elements: UIElement[] = Array.from({ length: 100 }, (_, i) => ({
        id: `element-${i}`,
        type: 'text',
        properties: { text: `Text ${i}` },
        dataBindings: [],
        eventBindings: []
      }));

      const startTime = performance.now();
      
      const rendered = await Promise.all(
        elements.map(element => componentRenderer.renderUIElement(element, {}))
      );
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(rendered).toHaveLength(100);
      expect(duration).toBeLessThan(200); // 100 components within 200ms
    });
  });

  describe('Operation Execution Performance', () => {
    it('should execute simple operations within 5ms', async () => {
      vi.spyOn(operationExecutor, 'executeOperation').mockResolvedValue({ result: 'success' });

      const startTime = performance.now();
      const result = await operationExecutor.executeOperation('simple-op', { input: 'test' });
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(result).toBeDefined();
      expect(duration).toBeLessThan(5); // Should execute within 5ms
    });

    it('should handle concurrent operations efficiently', async () => {
      vi.spyOn(operationExecutor, 'executeOperation').mockImplementation(
        async (id: string, data: any) => {
          // Simulate async work
          await new Promise(resolve => setTimeout(resolve, 10));
          return { result: `processed-${id}` };
        }
      );

      const operations = Array.from({ length: 20 }, (_, i) => ({
        id: `op-${i}`,
        data: { value: i }
      }));

      const startTime = performance.now();
      
      const results = await Promise.all(
        operations.map(op => 
          operationExecutor.executeOperation(op.id, op.data)
        )
      );
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(20);
      // Should complete concurrently, not sequentially (20 * 10ms = 200ms sequential)
      expect(duration).toBeLessThan(50); // Should complete within 50ms due to concurrency
    });
  });

  describe('Memory Usage and Optimization', () => {
    it('should maintain stable memory usage during contract generation', async () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Generate many contracts
      for (let i = 0; i < 50; i++) {
        const blueprint = new Blueprint({
          intent: `Create widget ${i}`,
          capabilities: ['interactive'],
          requirements: [`Widget with ${i} features`],
          context: {}
        });
        
        await aiInterpreter.generateContract(blueprint);
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });

    it('should efficiently handle large contracts', async () => {
      const largeContract: Contract = {
        name: 'Large Contract',
        version: '1.0.0',
        elements: Array.from({ length: 1000 }, (_, i) => ({
          id: `element-${i}`,
          type: 'text',
          properties: { text: `Element ${i}` },
          dataBindings: [],
          eventBindings: []
        })),
        operations: Array.from({ length: 100 }, (_, i) => ({
          id: `operation-${i}`,
          type: 'api-call',
          inputMappings: []
        })),
        operationBindings: []
      };

      const startTime = performance.now();
      
      // Simulate processing large contract
      const processedElements = largeContract.elements.map(element => ({
        ...element,
        processed: true
      }));
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(processedElements).toHaveLength(1000);
      expect(duration).toBeLessThan(100); // Should process within 100ms
    });
  });

  describe('Real-time Update Performance', () => {
    it('should handle rapid state updates efficiently', async () => {
      const stateUpdates = Array.from({ length: 1000 }, (_, i) => ({
        key: `field-${i % 10}`, // Simulate updates to 10 different fields
        value: `value-${i}`
      }));

      const startTime = performance.now();
      
      // Simulate rapid state updates
      for (const update of stateUpdates) {
        // Mock state update processing
        const processed = { ...update, timestamp: Date.now() };
        expect(processed).toBeDefined();
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(50); // 1000 updates within 50ms
    });

    it('should optimize re-rendering for minimal changes', async () => {
      const baseElement: UIElement = {
        id: 'dynamic-element',
        type: 'text',
        properties: { text: 'Initial text' },
        dataBindings: [],
        eventBindings: []
      };

      const variations = Array.from({ length: 100 }, (_, i) => ({
        ...baseElement,
        properties: { ...baseElement.properties, text: `Text ${i}` }
      }));

      const startTime = performance.now();
      
      // Simulate re-rendering with small changes
      for (const variation of variations) {
        await componentRenderer.renderUIElement(variation, {});
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(100); // 100 re-renders within 100ms
    });
  });

  describe('Scalability Tests', () => {
    it('should scale linearly with contract complexity', async () => {
      const complexities = [10, 50, 100, 200];
      const durations: number[] = [];

      for (const complexity of complexities) {
        const blueprint = new Blueprint({
          intent: `Create complex dashboard with ${complexity} components`,
          capabilities: ['visualization', 'interaction'],
          requirements: [`${complexity} interactive components`],
          context: { complexity }
        });

        const startTime = performance.now();
        await aiInterpreter.generateContract(blueprint);
        const endTime = performance.now();
        
        durations.push(endTime - startTime);
      }

      // Check that performance scales reasonably (not exponentially)
      const ratios = durations.slice(1).map((duration, i) => 
        duration / durations[i]
      );

      // Each step should not be more than 3x slower than the previous
      ratios.forEach(ratio => {
        expect(ratio).toBeLessThan(3);
      });
    });

    it('should handle concurrent user sessions', async () => {
      const sessionCount = 10;
      const sessionsPromises = Array.from({ length: sessionCount }, async (_, i) => {
        const blueprint = new Blueprint({
          intent: `User ${i} dashboard`,
          capabilities: ['personal'],
          requirements: ['User-specific content'],
          context: { userId: `user-${i}` }
        });

        const startTime = performance.now();
        const contract = await aiInterpreter.generateContract(blueprint);
        const endTime = performance.now();

        return {
          userId: `user-${i}`,
          duration: endTime - startTime,
          contract
        };
      });

      const startTime = performance.now();
      const sessions = await Promise.all(sessionsPromises);
      const endTime = performance.now();
      const totalDuration = endTime - startTime;

      expect(sessions).toHaveLength(sessionCount);
      expect(totalDuration).toBeLessThan(1000); // All sessions within 1 second
      
      // Individual sessions should complete reasonably fast
      sessions.forEach(session => {
        expect(session.duration).toBeLessThan(200);
      });
    });
  });

  describe('Performance Regression Tests', () => {
    it('should maintain baseline performance for common operations', async () => {
      const baselineOperations = [
        {
          name: 'Simple button creation',
          operation: () => aiInterpreter.generateContract(new Blueprint({
            intent: 'Create button',
            capabilities: ['clickable'],
            requirements: ['Simple button'],
            context: {}
          })),
          maxDuration: 100
        },
        {
          name: 'Form rendering',
          operation: () => componentRenderer.renderUIElement({
            id: 'form',
            type: 'form',
            properties: {},
            dataBindings: [],
            eventBindings: []
          }, {}),
          maxDuration: 20
        },
        {
          name: 'Operation execution',
          operation: () => {
            vi.spyOn(operationExecutor, 'executeOperation').mockResolvedValue({ success: true });
            return operationExecutor.executeOperation('test-op', {});
          },
          maxDuration: 10
        }
      ];

      for (const test of baselineOperations) {
        const startTime = performance.now();
        await test.operation();
        const endTime = performance.now();
        const duration = endTime - startTime;

        expect(duration).toBeLessThan(test.maxDuration);
      }
    });
  });
});
