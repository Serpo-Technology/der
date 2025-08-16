/**
 * Contract Builder - Transforms blueprints into contracts
 * Requirements: 2.1, 2.2, 2.5, 2.6
 */

import { Blueprint } from '../../types/blueprint';
import { Contract, UIElement, OperationBinding, LayoutSpec, StyleSpec, ContractMetadata, InputBinding, OutputBinding, TriggerSpec } from '../../types/contract';
import { ComponentRepository } from '../../types/repository';
import { UIElementManifest, OperationManifest, ComponentCriteria } from '../../types/component';
import { ValidationResult, ValidationError, ValidationWarning } from '../../interfaces/ai-interpreter';

export class ContractBuilder {
  private repository: ComponentRepository;

  constructor(repository: ComponentRepository) {
    this.repository = repository;
  }

  async generateFromBlueprint(blueprint: Blueprint): Promise<Contract> {
    try {
      // Resolve UI elements from blueprint requirements
      const resolvedUIElements = await this.resolveUIElements(blueprint);

      // Resolve operations from blueprint requirements
      const resolvedOperations = await this.resolveOperations(blueprint);

      // Create operation bindings with data flow
      const operationBindings = await this.createOperationBindings(blueprint, resolvedOperations, resolvedUIElements);

      // Generate layout specification
      const layout = this.generateLayout(resolvedUIElements);

      // Generate styling specification
      const styling = this.generateStyling(blueprint);

      // Create contract metadata
      const metadata = this.createMetadata(blueprint);

      const contract: Contract = {
        name: this.generateContractName(blueprint),
        version: '1.0.0',
        elements: resolvedUIElements,
        operations: operationBindings,
        layout,
        styling,
        metadata
      };

      // Validate the generated contract
      const validation = this.validateContract(contract);
      if (!validation.isValid) {
        throw new Error(`Generated contract is invalid: ${validation.errors.map(e => e.message).join(', ')}`);
      }

      return contract;
    } catch (error) {
      throw new Error(`Failed to generate contract from blueprint: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async resolveUIElements(blueprint: Blueprint): Promise<UIElement[]> {
    const elements: UIElement[] = [];

    for (const [index, elementReq] of blueprint.uiElements.entries()) {
      try {
        // Query repository for matching UI elements
        const criteria: ComponentCriteria = {
          type: 'ui-element',
          capabilities: elementReq.capabilities,
          name: elementReq.type
        };

        const manifests = await this.repository.queryUIElements(criteria);

        // Select the best matching manifest
        const selectedManifest = this.selectBestUIElementManifest(manifests, elementReq);

        if (!selectedManifest) {
          // Create a fallback element if no manifest found
          elements.push(this.createFallbackUIElement(elementReq, index));
          continue;
        }

        // Create UI element from manifest
        const element: UIElement = {
          id: `element_${index}`,
          type: selectedManifest.name,
          properties: this.generateElementProperties(selectedManifest, elementReq),
          dataBindings: [], // Will be populated when creating operation bindings
          eventBindings: [], // Will be populated when creating operation bindings
          children: []
        };

        elements.push(element);
      } catch {
        // Create fallback element on error
        elements.push(this.createFallbackUIElement(elementReq, index));
      }
    }

    return elements;
  }

  private async resolveOperations(blueprint: Blueprint): Promise<OperationManifest[]> {
    const operations: OperationManifest[] = [];

    for (const operationReq of blueprint.operations) {
      try {
        // Query repository for matching operations
        const criteria: ComponentCriteria = {
          type: 'operation',
          name: operationReq.name
        };

        const manifests = await this.repository.queryOperations(criteria);

        // Select the best matching manifest
        const selectedManifest = this.selectBestOperationManifest(manifests, operationReq);

        if (selectedManifest) {
          operations.push(selectedManifest);
        } else {
          // Create a placeholder operation manifest
          operations.push(this.createPlaceholderOperationManifest(operationReq));
        }
      } catch {
        // Create placeholder operation on error
        operations.push(this.createPlaceholderOperationManifest(operationReq));
      }
    }

    return operations;
  }

  private async createOperationBindings(
    blueprint: Blueprint,
    operations: OperationManifest[],
    elements: UIElement[]
  ): Promise<OperationBinding[]> {
    const bindings: OperationBinding[] = [];

    for (const [index, operation] of operations.entries()) {
      const blueprintOp = blueprint.operations[index];

      // Create input bindings from UI elements
      const inputBindings = this.createInputBindings(operation, elements, blueprintOp);

      // Create output bindings to UI elements
      const outputBindings = this.createOutputBindings(operation, elements, blueprintOp);

      // Create trigger specifications
      const triggers = this.createTriggerSpecs(operation, elements);

      const binding: OperationBinding = {
        id: `operation_${index}`,
        operationName: operation.name,
        inputs: inputBindings,
        outputs: outputBindings,
        triggers
      };

      bindings.push(binding);

      // Update UI elements with data and event bindings
      this.updateElementBindings(elements, binding, operation);
    }

    return bindings;
  }

  private createInputBindings(operation: OperationManifest, elements: UIElement[], _blueprintOp: unknown): InputBinding[] {
    const bindings: InputBinding[] = [];

    for (const input of operation.inputs) {
      // Find UI elements that can provide this input
      const sourceElement = elements.find(el =>
        this.canElementProvideInput(el, input.name, input.type)
      );

      if (sourceElement) {
        bindings.push({
          name: input.name,
          source: 'ui-element',
          sourceId: sourceElement.id,
          transform: this.createInputTransform(input, sourceElement)
        });
      } else {
        // Use constant or state as fallback
        bindings.push({
          name: input.name,
          source: 'constant',
          sourceId: 'default',
          transform: undefined
        });
      }
    }

    return bindings;
  }

  private createOutputBindings(operation: OperationManifest, elements: UIElement[], _blueprintOp: unknown): OutputBinding[] {
    const bindings: OutputBinding[] = [];

    for (const output of operation.outputs) {
      // Find UI elements that can display this output
      const targetElements = elements.filter(el =>
        this.canElementDisplayOutput(el, output.name, output.type)
      );

      for (const targetElement of targetElements) {
        bindings.push({
          name: output.name,
          target: 'ui-element',
          targetId: targetElement.id,
          property: this.getDisplayProperty(targetElement, output),
          transform: this.createOutputTransform(output, targetElement)
        });
      }
    }

    return bindings;
  }

  private createTriggerSpecs(_operation: OperationManifest, elements: UIElement[]): TriggerSpec[] {
    const triggers: TriggerSpec[] = [];

    // Create event-based triggers for user interactions
    const interactiveElements = elements.filter(el => this.isInteractiveElement(el));

    for (const element of interactiveElements) {
      triggers.push({
        type: 'event',
        condition: `element.${element.id}.interaction`,
        parameters: {
          elementId: element.id,
          eventType: this.getDefaultEventType(element)
        }
      });
    }

    return triggers;
  }

  private updateElementBindings(elements: UIElement[], binding: OperationBinding, _operation: OperationManifest): void {
    // Add data bindings to elements that receive operation outputs
    for (const output of binding.outputs) {
      if (output.target === 'ui-element') {
        const element = elements.find(el => el.id === output.targetId);
        if (element && output.property) {
          element.dataBindings.push({
            property: output.property,
            source: 'operation',
            sourceId: binding.id,
            transform: output.transform
          });
        }
      }
    }

    // Add event bindings to elements that trigger operations
    for (const trigger of binding.triggers) {
      if (trigger.type === 'event' && trigger.parameters?.elementId) {
        const element = elements.find(el => el.id === trigger.parameters!.elementId);
        if (element) {
          element.eventBindings.push({
            event: trigger.parameters!.eventType || 'click',
            operationId: binding.id,
            parameters: trigger.parameters
          });
        }
      }
    }
  }

  private generateLayout(_elements: UIElement[]): LayoutSpec {
    // Generate a simple flex layout by default
    return {
      type: 'flex',
      properties: {
        direction: 'column',
        gap: '16px',
        padding: '24px',
        alignItems: 'stretch'
      }
    };
  }

  private generateStyling(blueprint: Blueprint): StyleSpec {
    // Determine theme from capabilities
    const hasModernStyle = blueprint.requiredCapabilities.some(cap =>
      cap.includes('modern') || cap.includes('minimal')
    );

    const hasDarkTheme = blueprint.requiredCapabilities.some(cap =>
      cap.includes('dark')
    );

    return {
      theme: hasDarkTheme ? 'dark' : hasModernStyle ? 'modern' : 'default',
      customStyles: {}
    };
  }

  private createMetadata(blueprint: Blueprint): ContractMetadata {
    return {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0',
      description: blueprint.description,
      tags: blueprint.requiredCapabilities
    };
  }

  private generateContractName(blueprint: Blueprint): string {
    // Generate name from goal
    const words = blueprint.goal.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 0)
      .slice(0, 3);

    return words.join('-') || 'generated-experience';
  }

  validateContract(contract: Contract): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Validate required fields
    if (!contract.name || contract.name.trim().length === 0) {
      errors.push({
        path: 'name',
        message: 'Contract must have a name',
        code: 'MISSING_NAME'
      });
    }

    if (!contract.version || contract.version.trim().length === 0) {
      errors.push({
        path: 'version',
        message: 'Contract must have a version',
        code: 'MISSING_VERSION'
      });
    }

    // Validate elements
    if (contract.elements.length === 0) {
      warnings.push({
        path: 'elements',
        message: 'Contract has no UI elements',
        code: 'NO_ELEMENTS'
      });
    }

    contract.elements.forEach((element, index) => {
      if (!element.id || element.id.trim().length === 0) {
        errors.push({
          path: `elements[${index}].id`,
          message: 'UI element must have an ID',
          code: 'MISSING_ELEMENT_ID'
        });
      }

      if (!element.type || element.type.trim().length === 0) {
        errors.push({
          path: `elements[${index}].type`,
          message: 'UI element must have a type',
          code: 'MISSING_ELEMENT_TYPE'
        });
      }
    });

    // Validate operation bindings
    contract.operations.forEach((operation, index) => {
      if (!operation.id || operation.id.trim().length === 0) {
        errors.push({
          path: `operations[${index}].id`,
          message: 'Operation binding must have an ID',
          code: 'MISSING_OPERATION_ID'
        });
      }

      if (!operation.operationName || operation.operationName.trim().length === 0) {
        errors.push({
          path: `operations[${index}].operationName`,
          message: 'Operation binding must have an operation name',
          code: 'MISSING_OPERATION_NAME'
        });
      }
    });

    // Validate binding references
    this.validateBindingReferences(contract, errors);

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  private validateBindingReferences(contract: Contract, errors: ValidationError[]): void {
    const elementIds = new Set(contract.elements.map(el => el.id));
    const operationIds = new Set(contract.operations.map(op => op.id));

    // Check data binding references
    contract.elements.forEach((element, elementIndex) => {
      element.dataBindings.forEach((binding, bindingIndex) => {
        if (binding.source === 'operation' && !operationIds.has(binding.sourceId)) {
          errors.push({
            path: `elements[${elementIndex}].dataBindings[${bindingIndex}].sourceId`,
            message: `Data binding references non-existent operation: ${binding.sourceId}`,
            code: 'INVALID_BINDING_REFERENCE'
          });
        }
      });

      element.eventBindings.forEach((binding, bindingIndex) => {
        if (!operationIds.has(binding.operationId)) {
          errors.push({
            path: `elements[${elementIndex}].eventBindings[${bindingIndex}].operationId`,
            message: `Event binding references non-existent operation: ${binding.operationId}`,
            code: 'INVALID_BINDING_REFERENCE'
          });
        }
      });
    });

    // Check operation binding references
    contract.operations.forEach((operation, operationIndex) => {
      operation.inputs.forEach((input, inputIndex) => {
        if (input.source === 'ui-element' && !elementIds.has(input.sourceId)) {
          errors.push({
            path: `operations[${operationIndex}].inputs[${inputIndex}].sourceId`,
            message: `Input binding references non-existent element: ${input.sourceId}`,
            code: 'INVALID_BINDING_REFERENCE'
          });
        }
      });

      operation.outputs.forEach((output, outputIndex) => {
        if (output.target === 'ui-element' && !elementIds.has(output.targetId)) {
          errors.push({
            path: `operations[${operationIndex}].outputs[${outputIndex}].targetId`,
            message: `Output binding references non-existent element: ${output.targetId}`,
            code: 'INVALID_BINDING_REFERENCE'
          });
        }
      });
    });
  }

  // Helper methods
  private selectBestUIElementManifest(manifests: UIElementManifest[], requirement: any): UIElementManifest | null {
    if (manifests.length === 0) return null;

    // Score manifests based on capability match
    const scored = manifests.map(manifest => ({
      manifest,
      score: this.scoreUIElementMatch(manifest, requirement)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].manifest;
  }

  private selectBestOperationManifest(manifests: OperationManifest[], requirement: any): OperationManifest | null {
    if (manifests.length === 0) return null;

    // Score manifests based on name and execution type match
    const scored = manifests.map(manifest => ({
      manifest,
      score: this.scoreOperationMatch(manifest, requirement)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].manifest;
  }

  private scoreUIElementMatch(manifest: UIElementManifest, requirement: any): number {
    let score = 0;

    // Exact type match
    if (manifest.name === requirement.type) score += 10;

    // Capability matches
    const matchingCapabilities = requirement.capabilities.filter((cap: string) =>
      manifest.capabilities.includes(cap)
    );
    score += matchingCapabilities.length * 2;

    return score;
  }

  private scoreOperationMatch(manifest: OperationManifest, requirement: any): number {
    let score = 0;

    // Exact name match
    if (manifest.name === requirement.name) score += 10;

    // Execution type match
    if (manifest.executionType === requirement.executionType) score += 5;

    return score;
  }

  private createFallbackUIElement(requirement: any, index: number): UIElement {
    return {
      id: `fallback_element_${index}`,
      type: requirement.type || 'div',
      properties: {
        placeholder: true,
        purpose: requirement.purpose
      },
      dataBindings: [],
      eventBindings: [],
      children: []
    };
  }

  private createPlaceholderOperationManifest(requirement: any): OperationManifest {
    return {
      id: `placeholder_${requirement.name}`,
      name: requirement.name,
      version: '1.0.0',
      type: 'operation',
      description: requirement.purpose || 'Placeholder operation',
      capabilities: [],
      dependencies: [],
      schema: { type: 'object' },
      inputs: requirement.inputs.map((input: string) => ({
        name: input,
        type: 'string',
        required: false
      })),
      outputs: requirement.outputs.map((output: string) => ({
        name: output,
        type: 'string'
      })),
      executionType: requirement.executionType || 'local',
      implementation: {
        type: 'local',
        code: `// Placeholder implementation for ${requirement.name}`
      }
    };
  }

  private generateElementProperties(manifest: UIElementManifest, requirement: any): Record<string, any> {
    const properties: Record<string, any> = {};

    // Add properties from requirement
    if (requirement.properties) {
      Object.assign(properties, requirement.properties);
    }

    // Add default properties based on manifest
    if (manifest.schema.properties) {
      for (const [key, prop] of Object.entries(manifest.schema.properties)) {
        if (prop.default !== undefined && !(key in properties)) {
          properties[key] = prop.default;
        }
      }
    }

    return properties;
  }

  private canElementProvideInput(element: UIElement, inputName: string, inputType: string): boolean {
    // Simple heuristic: input elements can provide text, buttons can provide clicks
    if (element.type === 'input' && inputType === 'string') return true;
    if (element.type === 'button' && inputName.includes('trigger')) return true;
    if (element.type === 'select' && inputType === 'string') return true;
    return false;
  }

  private canElementDisplayOutput(element: UIElement, _outputName: string, outputType: string): boolean {
    // Simple heuristic: text elements can display strings, lists can display arrays
    if (element.type === 'text' && outputType === 'string') return true;
    if (element.type === 'list' && outputType === 'array') return true;
    if (element.type === 'chart' && outputType === 'object') return true;
    return false;
  }

  private getDisplayProperty(element: UIElement, _output: any): string {
    // Return appropriate property name for displaying output
    switch (element.type) {
      case 'text': return 'content';
      case 'list': return 'items';
      case 'chart': return 'data';
      case 'image': return 'src';
      default: return 'value';
    }
  }

  private isInteractiveElement(element: UIElement): boolean {
    const interactiveTypes = ['button', 'input', 'select', 'checkbox', 'radio'];
    return interactiveTypes.includes(element.type);
  }

  private getDefaultEventType(element: UIElement): string {
    switch (element.type) {
      case 'button': return 'click';
      case 'input': return 'change';
      case 'select': return 'change';
      case 'checkbox': return 'change';
      case 'radio': return 'change';
      default: return 'click';
    }
  }

  private createInputTransform(input: any, element: UIElement): any {
    // Create simple transforms based on input/element types
    if (input.type === 'number' && element.type === 'input') {
      return {
        type: 'parse-number',
        parameters: {}
      };
    }
    return undefined;
  }

  private createOutputTransform(output: any, element: UIElement): any {
    // Create simple transforms based on output/element types
    if (output.type === 'array' && element.type === 'text') {
      return {
        type: 'join-array',
        parameters: { separator: ', ' }
      };
    }
    return undefined;
  }
}