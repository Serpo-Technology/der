/**
 * Tests for validation utilities
 * Requirements: 1.2, 2.3, 2.7
 */

import { describe, it, expect } from 'vitest';
import {
  validateSchema,
  validateBlueprint,
  validateContract,
  validateUIElement,
  validateOperationBinding,
  validateInputSpec,
  validateOutputSpec,
  CONTRACT_SCHEMA
} from '../validation';
import type {
  Blueprint,
  Contract,
  UIElement,
  OperationBinding,
  InputSpec,
  OutputSpec
} from '../../types';

describe('Schema Validation', () => {
  it('should validate a valid contract schema', () => {
    const validContract = {
      name: 'Test Contract',
      version: '1.0.0',
      elements: [],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0'
      }
    };

    const result = validateSchema(validContract, CONTRACT_SCHEMA);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing required properties', () => {
    const invalidContract = {
      name: 'Test Contract'
      // Missing required properties
    };

    const result = validateSchema(invalidContract, CONTRACT_SCHEMA);
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.code === 'MISSING_REQUIRED')).toBe(true);
  });

  it('should detect type mismatches', () => {
    const invalidContract = {
      name: 123, // Should be string
      version: '1.0.0',
      elements: 'not-an-array', // Should be array
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0'
      }
    };

    const result = validateSchema(invalidContract, CONTRACT_SCHEMA);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'TYPE_MISMATCH')).toBe(true);
  });
});

describe('Blueprint Validation', () => {
  const validBlueprint: Blueprint = {
    description: 'A test application',
    goal: 'Test user interactions',
    requiredCapabilities: ['input', 'display'],
    uiElements: [
      {
        type: 'button',
        purpose: 'Submit form',
        capabilities: ['input'],
        properties: {}
      }
    ],
    operations: [
      {
        name: 'submitForm',
        purpose: 'Submit user data',
        inputs: ['formData'],
        outputs: ['result'],
        executionType: 'remote'
      }
    ],
    ambiguities: []
  };

  it('should validate a valid blueprint', () => {
    const result = validateBlueprint(validBlueprint);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing required fields', () => {
    const invalidBlueprint = {
      description: 'A test application'
      // Missing required fields
    } as Blueprint;

    const result = validateBlueprint(invalidBlueprint);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_REQUIRED')).toBe(true);
  });

  it('should warn about unmet capabilities', () => {
    const blueprintWithUnmetCapabilities: Blueprint = {
      ...validBlueprint,
      requiredCapabilities: ['input', 'display', 'unmet-capability']
    };

    const result = validateBlueprint(blueprintWithUnmetCapabilities);
    expect(result.isValid).toBe(true); // Still valid, just warnings
    expect(result.warnings.some(w => w.code === 'UNMET_CAPABILITY')).toBe(true);
  });

  it('should warn about empty UI elements', () => {
    const blueprintWithoutElements: Blueprint = {
      ...validBlueprint,
      uiElements: []
    };

    const result = validateBlueprint(blueprintWithoutElements);
    expect(result.warnings.some(w => w.code === 'NO_UI_ELEMENTS')).toBe(true);
  });
});

describe('Contract Validation', () => {
  const validContract: Contract = {
    name: 'Test Contract',
    version: '1.0.0',
    elements: [
      {
        id: 'button1',
        type: 'button',
        properties: { text: 'Click me' },
        dataBindings: [],
        eventBindings: [
          {
            event: 'click',
            operationId: 'op1',
            parameters: {}
          }
        ]
      }
    ],
    operations: [
      {
        id: 'op1',
        operationName: 'handleClick',
        inputs: [],
        outputs: [],
        triggers: [
          {
            type: 'event',
            parameters: {}
          }
        ]
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

  it('should validate a valid contract', () => {
    const result = validateContract(validContract);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect duplicate element IDs', () => {
    const contractWithDuplicateIds: Contract = {
      ...validContract,
      elements: [
        ...validContract.elements,
        {
          id: 'button1', // Duplicate ID
          type: 'input',
          properties: {},
          dataBindings: [],
          eventBindings: []
        }
      ]
    };

    const result = validateContract(contractWithDuplicateIds);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'DUPLICATE_IDS')).toBe(true);
  });

  it('should detect invalid operation references', () => {
    const contractWithInvalidRef: Contract = {
      ...validContract,
      elements: [
        {
          id: 'button1',
          type: 'button',
          properties: {},
          dataBindings: [
            {
              property: 'text',
              source: 'operation',
              sourceId: 'nonexistent-op' // Invalid reference
            }
          ],
          eventBindings: []
        }
      ]
    };

    const result = validateContract(contractWithInvalidRef);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_REFERENCE')).toBe(true);
  });
});

describe('UIElement Validation', () => {
  const validElement: UIElement = {
    id: 'element1',
    type: 'button',
    properties: { text: 'Click me' },
    dataBindings: [
      {
        property: 'text',
        source: 'operation',
        sourceId: 'op1'
      }
    ],
    eventBindings: [
      {
        event: 'click',
        operationId: 'op1'
      }
    ]
  };

  it('should validate a valid UI element', () => {
    const result = validateUIElement(validElement);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing ID', () => {
    const elementWithoutId: UIElement = {
      ...validElement,
      id: ''
    };

    const result = validateUIElement(elementWithoutId);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_ID')).toBe(true);
  });

  it('should detect missing type', () => {
    const elementWithoutType: UIElement = {
      ...validElement,
      type: ''
    };

    const result = validateUIElement(elementWithoutType);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_TYPE')).toBe(true);
  });

  it('should validate children recursively', () => {
    const elementWithInvalidChild: UIElement = {
      ...validElement,
      children: [
        {
          id: '', // Invalid child
          type: 'input',
          properties: {},
          dataBindings: [],
          eventBindings: []
        }
      ]
    };

    const result = validateUIElement(elementWithInvalidChild);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.path.includes('children[0]'))).toBe(true);
  });
});

describe('OperationBinding Validation', () => {
  const validBinding: OperationBinding = {
    id: 'binding1',
    operationName: 'testOperation',
    inputs: [
      {
        name: 'input1',
        source: 'ui-element',
        sourceId: 'element1'
      }
    ],
    outputs: [
      {
        name: 'output1',
        target: 'ui-element',
        targetId: 'element1'
      }
    ],
    triggers: [
      {
        type: 'event',
        parameters: {}
      }
    ]
  };

  it('should validate a valid operation binding', () => {
    const result = validateOperationBinding(validBinding);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing operation name', () => {
    const bindingWithoutName: OperationBinding = {
      ...validBinding,
      operationName: ''
    };

    const result = validateOperationBinding(bindingWithoutName);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_OPERATION_NAME')).toBe(true);
  });

  it('should detect invalid trigger types', () => {
    const bindingWithInvalidTrigger: OperationBinding = {
      ...validBinding,
      triggers: [
        {
          type: 'invalid-type' as any,
          parameters: {}
        }
      ]
    };

    const result = validateOperationBinding(bindingWithInvalidTrigger);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_TRIGGER_TYPE')).toBe(true);
  });
});

describe('InputSpec Validation', () => {
  const validInput: InputSpec = {
    name: 'testInput',
    type: 'string',
    required: true,
    description: 'A test input'
  };

  it('should validate a valid input spec', () => {
    const result = validateInputSpec(validInput);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing name', () => {
    const inputWithoutName: InputSpec = {
      ...validInput,
      name: ''
    };

    const result = validateInputSpec(inputWithoutName);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_NAME')).toBe(true);
  });

  it('should warn about non-standard types', () => {
    const inputWithCustomType: InputSpec = {
      ...validInput,
      type: 'custom-type'
    };

    const result = validateInputSpec(inputWithCustomType);
    expect(result.isValid).toBe(true);
    expect(result.warnings.some(w => w.code === 'NON_STANDARD_TYPE')).toBe(true);
  });
});

describe('OutputSpec Validation', () => {
  const validOutput: OutputSpec = {
    name: 'testOutput',
    type: 'string',
    description: 'A test output'
  };

  it('should validate a valid output spec', () => {
    const result = validateOutputSpec(validOutput);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing name', () => {
    const outputWithoutName: OutputSpec = {
      ...validOutput,
      name: ''
    };

    const result = validateOutputSpec(outputWithoutName);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_NAME')).toBe(true);
  });

  it('should warn about non-standard types', () => {
    const outputWithCustomType: OutputSpec = {
      ...validOutput,
      type: 'custom-type'
    };

    const result = validateOutputSpec(outputWithCustomType);
    expect(result.isValid).toBe(true);
    expect(result.warnings.some(w => w.code === 'NON_STANDARD_TYPE')).toBe(true);
  });
});