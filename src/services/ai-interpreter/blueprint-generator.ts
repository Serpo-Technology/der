/**
 * Blueprint Generator - derives the reviewable Blueprint shown in the
 * Blueprint tab. Creation projects it from the composed spec and contract;
 * refinement and validation operate on the projected result.
 */

import { Blueprint as BlueprintModel } from '../../models/blueprint';
import {
  Blueprint,
  ComposedSpec,
  Answer,
  UserModification,
  UIElementRequirement,
  OperationRequirement,
} from '../../types/blueprint';
import type { Contract, UIElement } from '../../types/contract';
import { ValidationResult, ValidationError, ValidationWarning } from '../../types/contract';
import type { ContractShape } from '../../schemas/contract';

export class BlueprintGenerator {
  /**
   * Projects a Blueprint from a composed creation result: goal from the spec,
   * elements and operations from the contract, ambiguities from the spec's
   * open questions. The projection feeds the Blueprint tab and its
   * "Generate Contract" regenerate path.
   */
  deriveFromComposition(
    spec: ComposedSpec,
    contract: Contract | ContractShape,
    description: string
  ): Blueprint {
    const uiElements: UIElementRequirement[] = [];
    const walk = (elements: UIElement[]) => {
      for (const element of elements) {
        const props = element.properties ?? {};
        const label =
          props.text ?? props.content ?? props.label ?? props.placeholder ?? element.id;
        uiElements.push({
          type: element.type,
          purpose: String(label),
          capabilities: [],
        });
        if (element.children?.length) walk(element.children as UIElement[]);
      }
    };
    walk((contract.elements ?? []) as UIElement[]);

    const operations: OperationRequirement[] = (contract.operations ?? []).map((op) => ({
      name: op.operationName,
      purpose: op.operationName,
      inputs: (op.inputs ?? []).map((input) => input.name),
      outputs: (op.outputs ?? []).map((output) => output.name),
      executionType: (op.executionType ?? 'builtin') as OperationRequirement['executionType'],
    }));

    const requiredCapabilities = [
      ...new Set([
        ...uiElements.map((element) => element.type),
        ...operations.map((operation) => operation.name),
      ]),
    ];

    return new BlueprintModel({
      description,
      goal: spec.goal || description,
      requiredCapabilities,
      uiElements,
      operations,
      ambiguities: spec.openQuestions.map((question, index) => ({
        id: `open-question-${index + 1}`,
        description: question,
        options: [],
        question,
      })),
      userModifications: [],
    });
  }

  refineWithAnswers(blueprint: Blueprint, answers: Answer[]): Blueprint {
    const refinedBlueprint = { ...blueprint };
    
    // Create a map of answers for quick lookup
    const answerMap = new Map(answers.map(answer => [answer.questionId, answer.value]));
    
    // Process each ambiguity and apply the user's answers
    refinedBlueprint.ambiguities = blueprint.ambiguities.filter(ambiguity => {
      const answer = answerMap.get(ambiguity.id);
      if (answer !== undefined) {
        // Apply the answer to refine the blueprint
        this.applyAmbiguityResolution(refinedBlueprint, ambiguity, answer);
        return false; // Remove resolved ambiguity
      }
      return true; // Keep unresolved ambiguities
    });

    // Record user modifications
    const modifications: UserModification[] = answers.map(answer => ({
      location: `ambiguity.${answer.questionId}`,
      originalValue: null,
      newValue: answer.value,
      timestamp: new Date(),
      preserved: true
    }));

    refinedBlueprint.userModifications = [
      ...(blueprint.userModifications || []),
      ...modifications
    ];

    return refinedBlueprint;
  }

  validateBlueprint(blueprint: Blueprint): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Validate required fields
    if (!blueprint.goal || blueprint.goal.trim().length === 0) {
      errors.push({
        path: 'goal',
        message: 'Blueprint must have a clear goal',
        code: 'MISSING_GOAL'
      });
    }

    if (!blueprint.description || blueprint.description.trim().length === 0) {
      errors.push({
        path: 'description',
        message: 'Blueprint must have a description',
        code: 'MISSING_DESCRIPTION'
      });
    }

    // Validate UI elements
    if (blueprint.uiElements.length === 0) {
      warnings.push({
        path: 'uiElements',
        message: 'Blueprint has no UI elements defined',
        code: 'NO_UI_ELEMENTS'
      });
    }

    blueprint.uiElements.forEach((element, index) => {
      if (!element.type || element.type.trim().length === 0) {
        errors.push({
          path: `uiElements[${index}].type`,
          message: 'UI element must have a type',
          code: 'MISSING_UI_ELEMENT_TYPE'
        });
      }

      if (!element.purpose || element.purpose.trim().length === 0) {
        warnings.push({
          path: `uiElements[${index}].purpose`,
          message: 'UI element should have a clear purpose',
          code: 'MISSING_UI_ELEMENT_PURPOSE'
        });
      }
    });

    // Validate operations
    blueprint.operations.forEach((operation, index) => {
      if (!operation.name || operation.name.trim().length === 0) {
        errors.push({
          path: `operations[${index}].name`,
          message: 'Operation must have a name',
          code: 'MISSING_OPERATION_NAME'
        });
      }

      if (!operation.purpose || operation.purpose.trim().length === 0) {
        warnings.push({
          path: `operations[${index}].purpose`,
          message: 'Operation should have a clear purpose',
          code: 'MISSING_OPERATION_PURPOSE'
        });
      }

      if (!['builtin', 'remote', 'local', 'repository'].includes(operation.executionType)) {
        errors.push({
          path: `operations[${index}].executionType`,
          message: 'Operation execution type must be builtin, remote, local, or repository',
          code: 'INVALID_EXECUTION_TYPE'
        });
      }
    });

    // Validate capabilities
    if (blueprint.requiredCapabilities.length === 0) {
      warnings.push({
        path: 'requiredCapabilities',
        message: 'Blueprint has no required capabilities defined',
        code: 'NO_CAPABILITIES'
      });
    }

    // Check for unresolved ambiguities
    if (blueprint.ambiguities.length > 0) {
      warnings.push({
        path: 'ambiguities',
        message: `Blueprint has ${blueprint.ambiguities.length} unresolved ambiguities`,
        code: 'UNRESOLVED_AMBIGUITIES'
      });
    }

    // Validate capability consistency
    const elementCapabilities = blueprint.uiElements.flatMap(el => el.capabilities);
    const operationCapabilities = blueprint.operations.map(op => op.name);
    const allRequiredCapabilities = [...elementCapabilities, ...operationCapabilities];
    
    const missingCapabilities = blueprint.requiredCapabilities.filter(
      cap => !allRequiredCapabilities.some(reqCap => reqCap.includes(cap) || cap.includes(reqCap))
    );

    if (missingCapabilities.length > 0) {
      warnings.push({
        path: 'requiredCapabilities',
        message: `Some required capabilities are not covered by UI elements or operations: ${missingCapabilities.join(', ')}`,
        code: 'UNCOVERED_CAPABILITIES'
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  private applyAmbiguityResolution(blueprint: Blueprint, ambiguity: any, answer: string | boolean): void {
    // Apply the resolution based on the ambiguity type and answer
    switch (ambiguity.id) {
      case 'ui_style':
        // Example: User chose a UI style preference
        if (typeof answer === 'string') {
          blueprint.requiredCapabilities.push(`ui-style-${answer.toLowerCase()}`);
        }
        break;
      
      case 'data_source':
        // Example: User specified data source type
        if (typeof answer === 'string') {
          const dataOperation = blueprint.operations.find(op => op.purpose.includes('data'));
          if (dataOperation) {
            dataOperation.executionType = answer.includes('api') ? 'remote' : 'local';
          }
        }
        break;
      
      case 'interaction_type':
        // Example: User specified interaction preferences
        if (typeof answer === 'string') {
          blueprint.requiredCapabilities.push(`interaction-${answer.toLowerCase()}`);
        }
        break;
      
      default:
        // Generic resolution: add as capability or modify description
        if (typeof answer === 'string') {
          blueprint.requiredCapabilities.push(`resolved-${ambiguity.id}-${answer.toLowerCase().replace(/\s+/g, '-')}`);
        }
        break;
    }
  }
}