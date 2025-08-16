/**
 * Blueprint Validator Component - Validation and error display for blueprints
 * Requirements: 5.1, 10.2, 10.3
 */

import React from 'react';
import { Blueprint } from '../../types/blueprint';
import { ValidationResult, ValidationError, ValidationWarning } from '../../types/contract';

interface BlueprintValidatorProps {
  blueprint: Blueprint;
  validation: ValidationResult;
}

export const BlueprintValidatorComponent: React.FC<BlueprintValidatorProps> = ({
  blueprint,
  validation
}) => {
  if (validation.isValid && validation.warnings.length === 0) {
    return (
      <div className="validation-panel success">
        <div className="validation-header">
          <span className="validation-icon">✓</span>
          <span>Blueprint is valid</span>
        </div>
      </div>
    );
  }

  return (
    <div className="validation-panel">
      {validation.errors.length > 0 && (
        <div className="validation-section errors">
          <div className="validation-header">
            <span className="validation-icon">✗</span>
            <span>Errors ({validation.errors.length})</span>
          </div>
          <ul className="validation-list">
            {validation.errors.map((error, index) => (
              <li key={index} className="validation-item error">
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validation.warnings.length > 0 && (
        <div className="validation-section warnings">
          <div className="validation-header">
            <span className="validation-icon">⚠</span>
            <span>Warnings ({validation.warnings.length})</span>
          </div>
          <ul className="validation-list">
            {validation.warnings.map((warning, index) => (
              <li key={index} className="validation-item warning">
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export class BlueprintValidator {
  validate(blueprint: Blueprint): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Required field validation
    if (!blueprint.description || blueprint.description.trim().length === 0) {
      errors.push({
        path: 'description',
        message: 'Description is required',
        code: 'REQUIRED_FIELD'
      });
    }

    if (!blueprint.goal || blueprint.goal.trim().length === 0) {
      errors.push({
        path: 'goal',
        message: 'Goal is required',
        code: 'REQUIRED_FIELD'
      });
    }

    // Content validation
    if (blueprint.description && blueprint.description.length < 10) {
      warnings.push({
        path: 'description',
        message: 'Description is very short - consider adding more detail',
        code: 'SHORT_CONTENT'
      });
    }

    if (blueprint.description && blueprint.description.length > 1000) {
      warnings.push({
        path: 'description',
        message: 'Description is very long - consider breaking it down',
        code: 'LONG_CONTENT'
      });
    }

    if (blueprint.requiredCapabilities.length === 0) {
      warnings.push({
        path: 'requiredCapabilities',
        message: 'No capabilities specified - this may limit functionality',
        code: 'MISSING_CAPABILITIES'
      });
    }

    if (blueprint.uiElements.length === 0) {
      warnings.push({
        path: 'uiElements',
        message: 'No UI elements specified - consider adding some interface elements',
        code: 'MISSING_UI_ELEMENTS'
      });
    }

    if (blueprint.operations.length === 0) {
      warnings.push({
        path: 'operations',
        message: 'No operations specified - consider adding some functionality',
        code: 'MISSING_OPERATIONS'
      });
    }

    // Ambiguity validation
    if (blueprint.ambiguities.length > 0) {
      warnings.push({
        path: 'ambiguities',
        message: `${blueprint.ambiguities.length} ambiguities detected - consider resolving them`,
        code: 'UNRESOLVED_AMBIGUITIES'
      });
    }

    // Capability validation
    const duplicateCapabilities = this.findDuplicates(blueprint.requiredCapabilities);
    if (duplicateCapabilities.length > 0) {
      warnings.push({
        path: 'requiredCapabilities',
        message: `Duplicate capabilities found: ${duplicateCapabilities.join(', ')}`,
        code: 'DUPLICATE_CAPABILITIES'
      });
    }

    // UI Element validation
    for (let i = 0; i < blueprint.uiElements.length; i++) {
      const element = blueprint.uiElements[i];
      if (!element.type || element.type.trim().length === 0) {
        errors.push({
          path: `uiElements[${i}].type`,
          message: `UI Element ${i + 1}: Type is required`,
          code: 'REQUIRED_FIELD'
        });
      }
      if (!element.purpose || element.purpose.trim().length === 0) {
        errors.push({
          path: `uiElements[${i}].purpose`,
          message: `UI Element ${i + 1}: Purpose is required`,
          code: 'REQUIRED_FIELD'
        });
      }
    }

    // Operation validation
    for (let i = 0; i < blueprint.operations.length; i++) {
      const operation = blueprint.operations[i];
      if (!operation.name || operation.name.trim().length === 0) {
        errors.push({
          path: `operations[${i}].name`,
          message: `Operation ${i + 1}: Name is required`,
          code: 'REQUIRED_FIELD'
        });
      }
      if (!operation.purpose || operation.purpose.trim().length === 0) {
        errors.push({
          path: `operations[${i}].purpose`,
          message: `Operation ${i + 1}: Purpose is required`,
          code: 'REQUIRED_FIELD'
        });
      }
      if (!['remote', 'local', 'repository'].includes(operation.executionType)) {
        errors.push({
          path: `operations[${i}].executionType`,
          message: `Operation ${i + 1}: Invalid execution type`,
          code: 'INVALID_VALUE'
        });
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  private findDuplicates(array: string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    
    for (const item of array) {
      if (seen.has(item)) {
        duplicates.add(item);
      } else {
        seen.add(item);
      }
    }
    
    return Array.from(duplicates);
  }
}