/**
 * Validation utilities for data models
 * Requirements: 1.2, 2.3, 2.7
 */

import type {
  Blueprint,
  Contract,
  UIElement,
  OperationBinding,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  JSONSchema,
  InputSpec,
  OutputSpec
} from '../types';

// JSON Schema validation for contracts
export const CONTRACT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Contract name' },
    version: { type: 'string', description: 'Contract version' },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          properties: { type: 'object' },
          dataBindings: { type: 'array' },
          eventBindings: { type: 'array' },
          children: { type: 'array' }
        }
      }
    },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          operationName: { type: 'string' },
          inputs: { type: 'array' },
          outputs: { type: 'array' },
          triggers: { type: 'array' }
        }
      }
    },
    layout: { type: 'object' },
    styling: { type: 'object' },
    metadata: { type: 'object' }
  },
  required: ['name', 'version', 'elements', 'operations', 'layout', 'styling', 'metadata']
};

// Blueprint validation schema
export const BLUEPRINT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Natural language description' },
    goal: { type: 'string', description: 'Primary goal of the experience' },
    requiredCapabilities: {
      type: 'array',
      items: { type: 'string' }
    },
    uiElements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          purpose: { type: 'string' },
          properties: { type: 'object' },
          capabilities: { type: 'array', items: { type: 'string' } }
        },
        required: ['type', 'purpose', 'capabilities']
      }
    },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          purpose: { type: 'string' },
          inputs: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'array', items: { type: 'string' } },
          executionType: { type: 'string', enum: ['builtin', 'remote', 'local', 'repository'] }
        },
        required: ['name', 'purpose', 'inputs', 'outputs', 'executionType']
      }
    },
    ambiguities: { type: 'array' },
    userModifications: { type: 'array' }
  },
  required: ['description', 'goal', 'requiredCapabilities', 'uiElements', 'operations', 'ambiguities']
};

/**
 * Validates a JSON object against a schema
 */
export function validateSchema(data: any, schema: JSONSchema): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  function validateProperty(value: any, propertySchema: any, path: string): void {
    if (propertySchema.type === 'string' && typeof value !== 'string') {
      errors.push({
        path,
        message: `Expected string, got ${typeof value}`,
        code: 'TYPE_MISMATCH'
      });
    } else if (propertySchema.type === 'number' && typeof value !== 'number') {
      errors.push({
        path,
        message: `Expected number, got ${typeof value}`,
        code: 'TYPE_MISMATCH'
      });
    } else if (propertySchema.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({
        path,
        message: `Expected boolean, got ${typeof value}`,
        code: 'TYPE_MISMATCH'
      });
    } else if (propertySchema.type === 'array' && !Array.isArray(value)) {
      errors.push({
        path,
        message: `Expected array, got ${typeof value}`,
        code: 'TYPE_MISMATCH'
      });
    } else if (propertySchema.type === 'object' && (typeof value !== 'object' || value === null)) {
      errors.push({
        path,
        message: `Expected object, got ${typeof value}`,
        code: 'TYPE_MISMATCH'
      });
    }

    // Validate enum values
    if (propertySchema.enum && !propertySchema.enum.includes(value)) {
      errors.push({
        path,
        message: `Value must be one of: ${propertySchema.enum.join(', ')}`,
        code: 'INVALID_ENUM'
      });
    }

    // Validate array items
    if (propertySchema.type === 'array' && Array.isArray(value) && propertySchema.items) {
      value.forEach((item, index) => {
        validateProperty(item, propertySchema.items, `${path}[${index}]`);
      });
    }

    // Validate object properties
    if (propertySchema.type === 'object' && typeof value === 'object' && value !== null && propertySchema.properties) {
      Object.entries(propertySchema.properties).forEach(([key, subSchema]) => {
        if (value[key] !== undefined) {
          validateProperty(value[key], subSchema, `${path}.${key}`);
        }
      });
    }
  }

  // Check required properties
  if (schema.required) {
    schema.required.forEach(requiredProp => {
      if (data[requiredProp] === undefined) {
        errors.push({
          path: requiredProp,
          message: `Required property '${requiredProp}' is missing`,
          code: 'MISSING_REQUIRED'
        });
      }
    });
  }

  // Validate each property
  if (schema.properties) {
    Object.entries(schema.properties).forEach(([key, propertySchema]) => {
      if (data[key] !== undefined) {
        validateProperty(data[key], propertySchema, key);
      }
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates a Blueprint object
 */
export function validateBlueprint(blueprint: Blueprint): ValidationResult {
  const schemaResult = validateSchema(blueprint, BLUEPRINT_SCHEMA);
  const errors = [...schemaResult.errors];
  const warnings = [...schemaResult.warnings];

  // Additional business logic validation
  if (blueprint.uiElements && blueprint.uiElements.length === 0) {
    warnings.push({
      path: 'uiElements',
      message: 'Blueprint has no UI elements defined',
      code: 'NO_UI_ELEMENTS'
    });
  }

  if (blueprint.operations && blueprint.operations.length === 0) {
    warnings.push({
      path: 'operations',
      message: 'Blueprint has no operations defined',
      code: 'NO_OPERATIONS'
    });
  }

  // Validate capability consistency
  if (blueprint.requiredCapabilities && blueprint.uiElements) {
    const requiredCapabilities = new Set(blueprint.requiredCapabilities);
    const elementCapabilities = new Set(
      blueprint.uiElements.flatMap(el => el.capabilities || [])
    );

    requiredCapabilities.forEach(capability => {
      if (!elementCapabilities.has(capability)) {
        warnings.push({
          path: 'requiredCapabilities',
          message: `Required capability '${capability}' is not provided by any UI element`,
          code: 'UNMET_CAPABILITY'
        });
      }
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates a Contract object
 */
export function validateContract(contract: Contract): ValidationResult {
  const schemaResult = validateSchema(contract, CONTRACT_SCHEMA);
  const errors = [...schemaResult.errors];
  const warnings = [...schemaResult.warnings];

  // Element ids and bindings live at every nesting level, so the id
  // collection and the reference checks walk the whole tree.
  const elementIds = new Set<string>();
  let elementCount = 0;
  const collectIds = (elements: UIElement[]) => {
    for (const element of elements) {
      elementCount += 1;
      elementIds.add(element.id);
      if (element.children?.length) collectIds(element.children);
    }
  };
  collectIds(contract.elements);
  const operationIds = new Set(contract.operations.map(op => op.id));

  // Validate element ID uniqueness
  if (elementIds.size !== elementCount) {
    errors.push({
      path: 'elements',
      message: 'Duplicate element IDs found',
      code: 'DUPLICATE_IDS'
    });
  }

  // Validate operation ID uniqueness
  if (operationIds.size !== contract.operations.length) {
    errors.push({
      path: 'operations',
      message: 'Duplicate operation IDs found',
      code: 'DUPLICATE_IDS'
    });
  }

  // Validate data binding references
  const visitElement = (element: UIElement, path: string) => {
    element.dataBindings.forEach((binding, bindingIndex) => {
      if (binding.source === 'operation' && !operationIds.has(binding.sourceId)) {
        errors.push({
          path: `${path}.dataBindings[${bindingIndex}].sourceId`,
          message: `Referenced operation '${binding.sourceId}' does not exist`,
          code: 'INVALID_REFERENCE'
        });
      }
    });

    element.eventBindings.forEach((binding, bindingIndex) => {
      if (!operationIds.has(binding.operationId)) {
        errors.push({
          path: `${path}.eventBindings[${bindingIndex}].operationId`,
          message: `Referenced operation '${binding.operationId}' does not exist`,
          code: 'INVALID_REFERENCE'
        });
      }
    });

    element.children?.forEach((child, childIndex) =>
      visitElement(child, `${path}.children[${childIndex}]`)
    );
  };
  contract.elements.forEach((element, index) => visitElement(element, `elements[${index}]`));

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates a UIElement object
 */
export function validateUIElement(element: UIElement): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Basic validation
  if (!element.id || element.id.trim() === '') {
    errors.push({
      path: 'id',
      message: 'Element ID is required and cannot be empty',
      code: 'MISSING_ID'
    });
  }

  if (!element.type || element.type.trim() === '') {
    errors.push({
      path: 'type',
      message: 'Element type is required and cannot be empty',
      code: 'MISSING_TYPE'
    });
  }

  // Validate data bindings
  element.dataBindings.forEach((binding, index) => {
    if (!binding.property || binding.property.trim() === '') {
      errors.push({
        path: `dataBindings[${index}].property`,
        message: 'Data binding property is required',
        code: 'MISSING_PROPERTY'
      });
    }

    if (!binding.sourceId || binding.sourceId.trim() === '') {
      errors.push({
        path: `dataBindings[${index}].sourceId`,
        message: 'Data binding source ID is required',
        code: 'MISSING_SOURCE_ID'
      });
    }
  });

  // Validate event bindings
  element.eventBindings.forEach((binding, index) => {
    if (!binding.event || binding.event.trim() === '') {
      errors.push({
        path: `eventBindings[${index}].event`,
        message: 'Event binding event name is required',
        code: 'MISSING_EVENT'
      });
    }

    if (!binding.operationId || binding.operationId.trim() === '') {
      errors.push({
        path: `eventBindings[${index}].operationId`,
        message: 'Event binding operation ID is required',
        code: 'MISSING_OPERATION_ID'
      });
    }
  });

  // Validate children recursively
  if (element.children) {
    element.children.forEach((child, index) => {
      const childResult = validateUIElement(child);
      childResult.errors.forEach(error => {
        errors.push({
          ...error,
          path: `children[${index}].${error.path}`
        });
      });
      childResult.warnings.forEach(warning => {
        warnings.push({
          ...warning,
          path: `children[${index}].${warning.path}`
        });
      });
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates an OperationBinding object
 */
export function validateOperationBinding(binding: OperationBinding): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Basic validation
  if (!binding.id || binding.id.trim() === '') {
    errors.push({
      path: 'id',
      message: 'Operation binding ID is required and cannot be empty',
      code: 'MISSING_ID'
    });
  }

  if (!binding.operationName || binding.operationName.trim() === '') {
    errors.push({
      path: 'operationName',
      message: 'Operation name is required and cannot be empty',
      code: 'MISSING_OPERATION_NAME'
    });
  }

  // Validate input bindings
  binding.inputs.forEach((input, index) => {
    if (!input.name || input.name.trim() === '') {
      errors.push({
        path: `inputs[${index}].name`,
        message: 'Input binding name is required',
        code: 'MISSING_INPUT_NAME'
      });
    }

    if (!input.sourceId || input.sourceId.trim() === '') {
      errors.push({
        path: `inputs[${index}].sourceId`,
        message: 'Input binding source ID is required',
        code: 'MISSING_SOURCE_ID'
      });
    }
  });

  // Validate output bindings
  binding.outputs.forEach((output, index) => {
    if (!output.name || output.name.trim() === '') {
      errors.push({
        path: `outputs[${index}].name`,
        message: 'Output binding name is required',
        code: 'MISSING_OUTPUT_NAME'
      });
    }

    if (!output.targetId || output.targetId.trim() === '') {
      errors.push({
        path: `outputs[${index}].targetId`,
        message: 'Output binding target ID is required',
        code: 'MISSING_TARGET_ID'
      });
    }
  });

  // Validate triggers
  binding.triggers.forEach((trigger, index) => {
    if (!trigger.type || trigger.type.trim() === '') {
      errors.push({
        path: `triggers[${index}].type`,
        message: 'Trigger type is required',
        code: 'MISSING_TRIGGER_TYPE'
      });
    }

    const validTriggerTypes = ['event', 'data-change', 'timer'];
    if (!validTriggerTypes.includes(trigger.type)) {
      errors.push({
        path: `triggers[${index}].type`,
        message: `Invalid trigger type. Must be one of: ${validTriggerTypes.join(', ')}`,
        code: 'INVALID_TRIGGER_TYPE'
      });
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates input specifications
 */
export function validateInputSpec(input: InputSpec): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!input.name || input.name.trim() === '') {
    errors.push({
      path: 'name',
      message: 'Input name is required and cannot be empty',
      code: 'MISSING_NAME'
    });
  }

  if (!input.type || input.type.trim() === '') {
    errors.push({
      path: 'type',
      message: 'Input type is required and cannot be empty',
      code: 'MISSING_TYPE'
    });
  }

  const validTypes = ['string', 'number', 'boolean', 'object', 'array'];
  if (input.type && !validTypes.includes(input.type)) {
    warnings.push({
      path: 'type',
      message: `Input type '${input.type}' is not a standard type. Consider using: ${validTypes.join(', ')}`,
      code: 'NON_STANDARD_TYPE'
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates output specifications
 */
export function validateOutputSpec(output: OutputSpec): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!output.name || output.name.trim() === '') {
    errors.push({
      path: 'name',
      message: 'Output name is required and cannot be empty',
      code: 'MISSING_NAME'
    });
  }

  if (!output.type || output.type.trim() === '') {
    errors.push({
      path: 'type',
      message: 'Output type is required and cannot be empty',
      code: 'MISSING_TYPE'
    });
  }

  const validTypes = ['string', 'number', 'boolean', 'object', 'array'];
  if (output.type && !validTypes.includes(output.type)) {
    warnings.push({
      path: 'type',
      message: `Output type '${output.type}' is not a standard type. Consider using: ${validTypes.join(', ')}`,
      code: 'NON_STANDARD_TYPE'
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}