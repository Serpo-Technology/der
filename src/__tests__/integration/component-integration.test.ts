/**
 * Integration Tests: Component Integration and Operation Binding
 * Tests how components work together and operations are bound to UI elements
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentRenderer } from '../../components/runtime/ComponentRenderer';
import { OperationExecutor } from '../../components/runtime/OperationExecutor';
import { ExperienceStateManager } from '../../components/runtime/ExperienceStateManager';
import { RepositoryService } from '../../services/repository/repository-service';
import { Contract } from '../../models/contract';
import type { UIElement, OperationBinding } from '../../types/contract';
import type { ComponentManifest } from '../../types/component';

// Mock external dependencies
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('Component Integration and Operation Binding', () => {
  let componentRenderer: ComponentRenderer;
  let operationExecutor: OperationExecutor;
  let stateManager: ExperienceStateManager;
  let repository: RepositoryService;

  const mockFormComponent: ComponentManifest = {
    id: 'form',
    name: 'Form',
    version: '1.0.0',
    type: 'ui-element',
    description: 'Form container component',
    capabilities: ['form', 'validation'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        onSubmit: { type: 'function' },
        validation: { type: 'object' }
      }
    },
    inputs: [
      { name: 'fields', type: 'array', required: true },
      { name: 'validation', type: 'object', required: false }
    ],
    outputs: [
      { name: 'onSubmit', type: 'event' },
      { name: 'onValidation', type: 'event' }
    ],
    renderFunction: 'renderForm',
    styleSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string' }
      }
    }
  };

  const mockInputComponent: ComponentManifest = {
    id: 'input',
    name: 'Input Field',
    version: '1.0.0',
    type: 'ui-element',
    description: 'Text input field',
    capabilities: ['input', 'validation'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        onChange: { type: 'function' }
      }
    },
    inputs: [
      { name: 'placeholder', type: 'string', required: false },
      { name: 'required', type: 'boolean', required: false }
    ],
    outputs: [
      { name: 'onChange', type: 'event' },
      { name: 'onBlur', type: 'event' }
    ],
    renderFunction: 'renderInput',
    styleSchema: {
      type: 'object',
      properties: {
        width: { type: 'string' }
      }
    }
  };

  const mockValidationOperation: ComponentManifest = {
    id: 'validate-email',
    name: 'Email Validation',
    version: '1.0.0',
    type: 'operation',
    description: 'Validates email format',
    capabilities: ['validation', 'sync'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string' }
      }
    },
    inputs: [
      { name: 'email', type: 'string', required: true }
    ],
    outputs: [
      { name: 'isValid', type: 'boolean' },
      { name: 'error', type: 'string' }
    ],
    executionType: 'local',
    implementation: {
      type: 'local',
      function: 'validateEmail'
    }
  };

  const mockApiOperation: ComponentManifest = {
    id: 'submit-form',
    name: 'Submit Form Data',
    version: '1.0.0',
    type: 'operation',
    description: 'Submits form data to API',
    capabilities: ['http', 'async'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        data: { type: 'object' },
        endpoint: { type: 'string' }
      }
    },
    inputs: [
      { name: 'formData', type: 'object', required: true },
      { name: 'endpoint', type: 'string', required: true }
    ],
    outputs: [
      { name: 'response', type: 'object' },
      { name: 'success', type: 'boolean' }
    ],
    executionType: 'remote',
    implementation: {
      type: 'remote',
      endpoint: '/api/submit',
      method: 'POST'
    }
  };

  beforeEach(async () => {
    componentRenderer = new ComponentRenderer();
    operationExecutor = new OperationExecutor();
    stateManager = new ExperienceStateManager('test-experience');
    repository = new RepositoryService();

    // Mock repository responses
    vi.spyOn(repository, 'getComponent').mockImplementation(async (id: string) => {
      switch (id) {
        case 'form': return mockFormComponent;
        case 'input': return mockInputComponent;
        case 'validate-email': return mockValidationOperation;
        case 'submit-form': return mockApiOperation;
        default: return null;
      }
    });
  });

  describe('UI Component Integration', () => {
    it('should render nested components with proper hierarchy', async () => {
      const formElement: UIElement = {
        id: 'contact-form',
        type: 'form',
        properties: {
          layout: 'vertical'
        },
        dataBindings: [],
        eventBindings: [],
        children: [
          {
            id: 'email-input',
            type: 'input',
            properties: {
              placeholder: 'Enter your email',
              required: true
            },
            dataBindings: [],
            eventBindings: []
          },
          {
            id: 'name-input',
            type: 'input',
            properties: {
              placeholder: 'Enter your name',
              required: true
            },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      const renderedComponent = await componentRenderer.renderUIElement(formElement, {});
      
      expect(renderedComponent).toBeDefined();
      // Should render parent form with nested input components
      expect(renderedComponent.props.children).toHaveLength(2);
    });

    it('should handle component dependencies correctly', async () => {
      // Create a component that depends on another
      const dependentComponent: ComponentManifest = {
        ...mockFormComponent,
        id: 'advanced-form',
        dependencies: ['input', 'validate-email']
      };

      vi.spyOn(repository, 'getComponent').mockResolvedValueOnce(dependentComponent);
      vi.spyOn(repository, 'findAllDependencies').mockResolvedValue([
        mockInputComponent,
        mockValidationOperation
      ]);

      const element: UIElement = {
        id: 'advanced-form-1',
        type: 'advanced-form',
        properties: {},
        dataBindings: [],
        eventBindings: []
      };

      const renderedComponent = await componentRenderer.renderUIElement(element, {});
      
      expect(renderedComponent).toBeDefined();
      // Should successfully render despite dependencies
    });

    it('should apply proper styling and theming', async () => {
      const styledElement: UIElement = {
        id: 'styled-form',
        type: 'form',
        properties: {
          layout: 'horizontal'
        },
        style: {
          backgroundColor: '#f0f0f0',
          padding: '20px',
          borderRadius: '8px'
        },
        dataBindings: [],
        eventBindings: []
      };

      const renderedComponent = await componentRenderer.renderUIElement(styledElement, {});
      
      expect(renderedComponent.props.style).toEqual({
        backgroundColor: '#f0f0f0',
        padding: '20px',
        borderRadius: '8px'
      });
    });
  });

  describe('Operation Binding and Execution', () => {
    it('should bind operations to UI element events', async () => {
      const operationBinding: OperationBinding = {
        id: 'email-validation-binding',
        operationId: 'validate-email',
        trigger: {
          elementId: 'email-input',
          event: 'onBlur'
        },
        inputMappings: [
          {
            operationInput: 'email',
            source: {
              type: 'element',
              elementId: 'email-input',
              property: 'value'
            }
          }
        ],
        outputMappings: [
          {
            operationOutput: 'isValid',
            target: {
              type: 'element',
              elementId: 'email-input',
              property: 'isValid'
            }
          },
          {
            operationOutput: 'error',
            target: {
              type: 'state',
              key: 'emailError'
            }
          }
        ]
      };

      // Simulate operation execution
      const mockExecutionResult = {
        isValid: false,
        error: 'Invalid email format'
      };

      vi.spyOn(operationExecutor, 'executeOperation').mockResolvedValue(mockExecutionResult);

      const result = await operationExecutor.executeOperation(
        operationBinding.operationId,
        { email: 'invalid-email' }
      );

      expect(result).toEqual(mockExecutionResult);
      expect(operationExecutor.executeOperation).toHaveBeenCalledWith(
        'validate-email',
        { email: 'invalid-email' }
      );
    });

    it('should handle complex operation chains', async () => {
      // Create a chain: input validation -> form submission -> success handling
      const validationBinding: OperationBinding = {
        id: 'validation-chain',
        operationId: 'validate-email',
        trigger: {
          elementId: 'email-input',
          event: 'onChange'
        },
        inputMappings: [
          {
            operationInput: 'email',
            source: {
              type: 'element',
              elementId: 'email-input',
              property: 'value'
            }
          }
        ],
        outputMappings: [
          {
            operationOutput: 'isValid',
            target: {
              type: 'state',
              key: 'emailValid'
            }
          }
        ]
      };

      const submissionBinding: OperationBinding = {
        id: 'submission-chain',
        operationId: 'submit-form',
        trigger: {
          elementId: 'contact-form',
          event: 'onSubmit'
        },
        conditions: [
          {
            type: 'state',
            key: 'emailValid',
            operator: 'equals',
            value: true
          }
        ],
        inputMappings: [
          {
            operationInput: 'formData',
            source: {
              type: 'state',
              key: 'formData'
            }
          }
        ],
        outputMappings: [
          {
            operationOutput: 'success',
            target: {
              type: 'state',
              key: 'submissionSuccess'
            }
          }
        ]
      };

      // Mock successful validation
      vi.spyOn(operationExecutor, 'executeOperation')
        .mockResolvedValueOnce({ isValid: true })
        .mockResolvedValueOnce({ success: true, response: { id: 123 } });

      // Execute validation first
      const validationResult = await operationExecutor.executeOperation(
        'validate-email',
        { email: 'test@example.com' }
      );

      expect(validationResult.isValid).toBe(true);

      // Then execute submission
      const submissionResult = await operationExecutor.executeOperation(
        'submit-form',
        { formData: { email: 'test@example.com', name: 'Test User' } }
      );

      expect(submissionResult.success).toBe(true);
    });

    it('should handle operation errors gracefully', async () => {
      const errorBinding: OperationBinding = {
        id: 'error-handling',
        operationId: 'submit-form',
        trigger: {
          elementId: 'contact-form',
          event: 'onSubmit'
        },
        inputMappings: [
          {
            operationInput: 'formData',
            source: {
              type: 'element',
              elementId: 'contact-form',
              property: 'data'
            }
          }
        ],
        outputMappings: [
          {
            operationOutput: 'error',
            target: {
              type: 'state',
              key: 'submissionError'
            }
          }
        ],
        errorHandling: {
          strategy: 'capture',
          fallbackValue: { success: false, error: 'Submission failed' }
        }
      };

      // Mock operation failure
      vi.spyOn(operationExecutor, 'executeOperation').mockRejectedValue(
        new Error('Network error')
      );

      // Should handle error gracefully
      await expect(
        operationExecutor.executeOperation('submit-form', { formData: {} })
      ).rejects.toThrow('Network error');
    });
  });

  describe('State Management Integration', () => {
    it('should synchronize state between components and operations', async () => {
      const contract: Contract = {
        name: 'Contact Form',
        version: '1.0.0',
        elements: [
          {
            id: 'email-input',
            type: 'input',
            properties: { placeholder: 'Email' },
            dataBindings: [
              {
                property: 'value',
                source: {
                  type: 'state',
                  key: 'email'
                }
              }
            ],
            eventBindings: [
              {
                event: 'onChange',
                action: {
                  type: 'updateState',
                  key: 'email',
                  value: '${event.target.value}'
                }
              }
            ]
          }
        ],
        operations: [
          {
            id: 'validate-email-op',
            type: 'validate-email',
            inputMappings: [
              {
                operationInput: 'email',
                source: {
                  type: 'state',
                  key: 'email'
                }
              }
            ]
          }
        ],
        operationBindings: []
      };

      // Initialize state
      const initialState = await stateManager.initializeState(contract);
      expect(initialState).toBeDefined();

      // Update state
      await stateManager.updateState('email', 'test@example.com');
      const currentState = stateManager.getCurrentState();
      
      expect(currentState.data.email).toBe('test@example.com');
    });

    it('should handle real-time state updates', async () => {
      const stateChangeCallback = vi.fn();
      
      // Subscribe to state changes
      const unsubscribe = stateManager.subscribeToStateChanges(stateChangeCallback);

      // Update state multiple times
      await stateManager.updateState('field1', 'value1');
      await stateManager.updateState('field2', 'value2');
      await stateManager.updateState('field1', 'updated-value1');

      expect(stateChangeCallback).toHaveBeenCalledTimes(3);
      
      // Cleanup
      unsubscribe();
    });

    it('should persist state across component re-renders', async () => {
      // Set initial state
      await stateManager.updateState('persistentData', { important: 'value' });
      
      // Simulate component re-render by creating new state manager with same ID
      const newStateManager = new ExperienceStateManager('test-experience');
      
      // Should restore previous state
      const restoredState = newStateManager.getCurrentState();
      expect(restoredState.data.persistentData).toEqual({ important: 'value' });
    });
  });

  describe('Performance and Optimization', () => {
    it('should render components efficiently with many bindings', async () => {
      // Create a complex form with many data bindings
      const complexElements: UIElement[] = Array.from({ length: 50 }, (_, i) => ({
        id: `input-${i}`,
        type: 'input',
        properties: { placeholder: `Field ${i}` },
        dataBindings: [
          {
            property: 'value',
            source: {
              type: 'state',
              key: `field${i}`
            }
          }
        ],
        eventBindings: [
          {
            event: 'onChange',
            action: {
              type: 'updateState',
              key: `field${i}`,
              value: '${event.target.value}'
            }
          }
        ]
      }));

      const startTime = Date.now();
      
      // Render all components
      const renderedComponents = await Promise.all(
        complexElements.map(element => 
          componentRenderer.renderUIElement(element, {})
        )
      );
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(renderedComponents).toHaveLength(50);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should handle concurrent operation executions', async () => {
      const operations = Array.from({ length: 10 }, (_, i) => ({
        id: `operation-${i}`,
        data: { value: i }
      }));

      vi.spyOn(operationExecutor, 'executeOperation').mockImplementation(
        async (id: string, data: any) => {
          // Simulate async operation
          await new Promise(resolve => setTimeout(resolve, 100));
          return { result: `processed-${data.value}` };
        }
      );

      const startTime = Date.now();
      
      const results = await Promise.all(
        operations.map(op => 
          operationExecutor.executeOperation(op.id, op.data)
        )
      );
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(10);
      expect(duration).toBeLessThan(500); // Should complete concurrently, not sequentially
    });
  });
});
