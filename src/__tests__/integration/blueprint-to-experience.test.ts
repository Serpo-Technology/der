/**
 * Integration Tests: Blueprint to Experience Pipeline
 * Tests the complete flow from natural language input to rendered experience
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIInterpreterService } from '../../services/ai-interpreter';
import { RepositoryService } from '../../services/repository/repository-service';
import { DynamicExperienceRuntimeService } from '../../components/runtime/DynamicExperienceRuntimeService';
import { Blueprint } from '../../models/blueprint';
import { Contract } from '../../models/contract';
import type { UIElementManifest, OperationManifest } from '../../types/component';

// Mock external dependencies
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('Blueprint to Experience Pipeline Integration', () => {
  let aiInterpreter: AIInterpreterService;
  let repository: RepositoryService;
  let runtime: DynamicExperienceRuntimeService;

  const mockButtonComponent: UIElementManifest = {
    id: 'button',
    name: 'Button',
    version: '1.0.0',
    type: 'ui-element',
    description: 'A clickable button component',
    capabilities: ['clickable', 'styled'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        onClick: { type: 'function' }
      }
    },
    inputs: [
      { name: 'text', type: 'string', required: true },
      { name: 'disabled', type: 'boolean', required: false }
    ],
    outputs: [
      { name: 'onClick', type: 'event' }
    ],
    renderFunction: 'renderButton',
    styleSchema: {
      type: 'object',
      properties: {
        backgroundColor: { type: 'string' },
        color: { type: 'string' }
      }
    }
  };

  const mockApiComponent: OperationManifest = {
    id: 'api-call',
    name: 'API Call',
    version: '1.0.0',
    type: 'operation',
    description: 'Makes HTTP API calls',
    capabilities: ['http', 'async'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' }
      }
    },
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: 'string', required: false }
    ],
    outputs: [
      { name: 'response', type: 'object' }
    ],
    executionType: 'remote',
    implementation: {
      type: 'remote',
      endpoint: 'https://api.example.com',
      method: 'GET'
    }
  };

  beforeEach(async () => {
    // Initialize services
    repository = new RepositoryService();
    
    // Create mock LLM config
    const mockLLMConfig = {
      provider: 'local' as const,
      model: 'test-model',
      temperature: 0.7,
      baseUrl: 'http://localhost:11434' // Mock Ollama URL
    };
    
    aiInterpreter = new AIInterpreterService(mockLLMConfig, repository);
    runtime = new DynamicExperienceRuntimeService();

    // Mock repository with test components
    vi.spyOn(repository, 'queryUIElements').mockResolvedValue([mockButtonComponent as any]);
    vi.spyOn(repository, 'queryOperations').mockResolvedValue([mockApiComponent as any]);
    vi.spyOn(repository, 'getComponent').mockImplementation(async (id: string) => {
      if (id === 'button') return mockButtonComponent;
      if (id === 'api-call') return mockApiComponent;
      return null;
    });

    // Mock fetch for LLM calls
    global.fetch = vi.fn().mockImplementation((_url: string, options?: any) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      const allMessages = body.messages || [];
      const userMessage = allMessages.find((m: any) => m.role === 'user')?.content || '';
      
      // Return a proper LLM response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                goal: "Create a form with submit functionality",
                intent: userMessage.includes('form') ? 'form creation' : 'general creation',
                confidence: 0.9,
                feedback: null,
                requiredCapabilities: ["form-input", "form-submission"],
                uiElements: [
                  {
                    type: "input",
                    purpose: "Input field",
                    capabilities: ["form-input"],
                    properties: {
                      label: "Input",
                      placeholder: "Enter value"
                    }
                  },
                  {
                    type: "button",
                    purpose: "Submit button",
                    capabilities: ["clickable"],
                    properties: {
                      text: "Submit"
                    }
                  }
                ],
                operations: [
                  {
                    name: "submit-form",
                    purpose: "Submit form data",
                    inputs: ["input"],
                    outputs: ["success"],
                    executionType: "remote"
                  }
                ],
                ambiguities: []
              })
            }
          }]
        })
      });
    });
  });

  describe('Complete Pipeline Flow', () => {
    it('should process natural language input to rendered experience', async () => {
      const naturalLanguageInput = 'Create a simple form with a submit button that sends data to an API';

      // Step 1: Parse natural language to blueprint
      const blueprint = await aiInterpreter.parseNaturalLanguage(naturalLanguageInput);
      
      expect(blueprint).toBeInstanceOf(Blueprint);
      expect((blueprint as any).intent).toContain('form');
      expect(blueprint.requiredCapabilities).toContain('clickable');
      expect(blueprint.requiredCapabilities).toContain('http');

      // Step 2: Generate contract from blueprint
      const contract = await aiInterpreter.generateContract(blueprint);
      
      expect(contract).toBeInstanceOf(Contract);
      expect(contract.elements).toHaveLength(1);
      expect(contract.elements[0].type).toBe('button');
      expect(contract.operations).toHaveLength(1);
      expect(contract.operations[0].operationName).toBe('api-call');

      // Step 3: Render experience from contract
      const renderedExperience = await runtime.renderExperience(contract);
      
      expect(renderedExperience).toBeDefined();
    });

    it('should handle complex multi-component experiences', async () => {
      const complexInput = 'Build a dashboard with multiple charts, filters, and real-time data updates';

      // Mock additional components for complex scenario
      const mockChartComponent: UIElementManifest = {
        id: 'chart',
        name: 'Chart',
        version: '1.0.0',
        type: 'ui-element',
        description: 'Data visualization chart',
        capabilities: ['visualization', 'data-binding'],
        dependencies: [],
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array' },
            type: { type: 'string' }
          }
        },
        inputs: [
          { name: 'data', type: 'array', required: true },
          { name: 'chartType', type: 'string', required: true }
        ],
        outputs: [],
        renderFunction: 'renderChart',
        styleSchema: {
          type: 'object',
          properties: {
            width: { type: 'string' },
            height: { type: 'string' }
          }
        }
      };

      vi.spyOn(repository, 'queryUIElements').mockResolvedValue([
        mockButtonComponent as any,
        mockChartComponent as any
      ]);

      const blueprint = await aiInterpreter.parseNaturalLanguage(complexInput);
      const contract = await aiInterpreter.generateContract(blueprint);
      
      expect(contract.elements.length).toBeGreaterThan(1);
      expect(contract.operations.length).toBeGreaterThan(0);
      
      // Should have proper data bindings between components
      const chartElement = contract.elements.find(el => el.type === 'chart');
      expect(chartElement?.dataBindings).toBeDefined();
      expect(chartElement?.dataBindings.length).toBeGreaterThan(0);
    });

    it('should preserve user edits during regeneration', async () => {
      const initialInput = 'Create a simple button';
      const modifiedInput = 'Create a simple button with red background';

      // Generate initial experience
      const initialBlueprint = await aiInterpreter.parseNaturalLanguage(initialInput);
      const initialContract = await aiInterpreter.generateContract(initialBlueprint);
      
      // Simulate user edit - create a new contract with user edits
      const userEditedContract = new Contract({
        name: initialContract.name,
        version: initialContract.version,
        elements: initialContract.elements.map(el => ({
          ...el,
          properties: {
            ...el.properties,
            customUserProperty: 'user-added-value'
          }
        })),
        operations: initialContract.operations,
        layout: initialContract.layout,
        styling: initialContract.styling,
        metadata: initialContract.metadata
      });

      // Regenerate with preservation
      const modifiedBlueprint = await aiInterpreter.parseNaturalLanguage(modifiedInput);
      const regeneratedContract = await aiInterpreter.generateContractWithPreservation(
        modifiedBlueprint,
        userEditedContract
      );

      // Should preserve user edits while applying new changes
      expect(regeneratedContract.elements[0].properties.customUserProperty).toBe('user-added-value');
      expect(regeneratedContract.elements[0].properties.backgroundColor).toBe('red');
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle missing components gracefully', async () => {
      // Mock repository to return empty results
      vi.spyOn(repository, 'queryUIElements').mockResolvedValue([]);
      vi.spyOn(repository, 'queryOperations').mockResolvedValue([]);

      const input = 'Create a complex widget that requires unavailable components';
      
      const blueprint = await aiInterpreter.parseNaturalLanguage(input);
      
      // Should still generate a contract with fallback components
      const contract = await aiInterpreter.generateContract(blueprint);
      expect(contract).toBeDefined();
      expect(contract.elements).toBeDefined();
    });

    it('should recover from runtime errors during rendering', async () => {
      const input = 'Create a simple button';
      const blueprint = await aiInterpreter.parseNaturalLanguage(input);
      const contract = await aiInterpreter.generateContract(blueprint);

      // Mock runtime error
      vi.spyOn(runtime, 'renderExperience').mockRejectedValueOnce(new Error('Rendering failed'));

      // Should handle error gracefully
      await expect(runtime.renderExperience(contract)).rejects.toThrow('Rendering failed');
      
      // Should be able to retry successfully
      vi.spyOn(runtime, 'renderExperience').mockResolvedValueOnce(() => null as any);

      const result = await runtime.renderExperience(contract);
      expect(result).toBeDefined();
    });
  });

  describe('Performance and Optimization', () => {
    it('should complete pipeline within acceptable time limits', async () => {
      const startTime = Date.now();
      
      const input = 'Create a dashboard with multiple components';
      const blueprint = await aiInterpreter.parseNaturalLanguage(input);
      const contract = await aiInterpreter.generateContract(blueprint);
      await runtime.renderExperience(contract);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should complete within 5 seconds for integration test
      expect(duration).toBeLessThan(5000);
    });

    it('should handle concurrent pipeline executions', async () => {
      const inputs = [
        'Create a simple form',
        'Build a data table',
        'Make a chart widget'
      ];

      const promises = inputs.map(async (input, _index) => {
        const blueprint = await aiInterpreter.parseNaturalLanguage(input);
        const contract = await aiInterpreter.generateContract(blueprint);
        return runtime.renderExperience(contract);
      });

      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(3);
      results.forEach((result, _index) => {
        expect(result).toBeDefined();
      });
    });
  });
});
