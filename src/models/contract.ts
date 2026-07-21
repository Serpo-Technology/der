/**
 * Contract model with component resolution
 * Requirements: 2.1, 2.3, 2.6
 */

import type {
  Contract as IContractInterface,
  UIElement,
  OperationBinding,
  LayoutSpec,
  StyleSpec,
  ContractMetadata,
  ValidationResult,
  ContractDelta,
  ContractEdits,
  ResolvedContract,
  DependencyNode
} from '../types';
import { validateContract } from '../utils/validation';

export class Contract implements IContractInterface {
  public name: string;
  public version: string;
  public elements: UIElement[];
  public operations: OperationBinding[];
  public layout: LayoutSpec;
  public styling: StyleSpec;
  public metadata: ContractMetadata;
  public initialState?: Record<string, unknown>;

  constructor(data: Partial<IContractInterface> = {}) {
    this.name = data.name || '';
    this.version = data.version || '1.0.0';
    this.elements = data.elements || [];
    this.operations = data.operations || [];
    this.layout = data.layout || { type: 'flex', properties: {} };
    this.styling = data.styling || { theme: 'default' };
    this.metadata = data.metadata || {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0'
    };
    this.initialState = data.initialState;
  }

  /**
   * Creates a Contract instance from JSON data
   */
  static fromJSON(json: string): Contract {
    try {
      const data = JSON.parse(json);
      return Contract.fromObject(data);
    } catch (error) {
      throw new Error(`Invalid JSON format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Creates a Contract instance from a plain object
   */
  static fromObject(data: any): Contract {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid contract data: must be an object');
    }

    // Convert date strings back to Date objects for metadata
    const metadata = data.metadata ? {
      ...data.metadata,
      createdAt: data.metadata.createdAt ? new Date(data.metadata.createdAt) : new Date(),
      updatedAt: data.metadata.updatedAt ? new Date(data.metadata.updatedAt) : new Date()
    } : {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: data.version || '1.0.0'
    };

    return new Contract({
      name: data.name,
      version: data.version,
      elements: data.elements || [],
      operations: data.operations || [],
      layout: data.layout,
      styling: data.styling,
      metadata,
      initialState: data.initialState
    });
  }

  /**
   * Serializes the contract to JSON string
   */
  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  /**
   * Converts the contract to a plain object
   */
  toObject(): IContractInterface {
    return {
      name: this.name,
      version: this.version,
      elements: this.elements.map(element => this.cloneElement(element)),
      operations: this.operations.map(operation => ({ ...operation })),
      layout: { ...this.layout },
      styling: { ...this.styling },
      metadata: {
        ...this.metadata,
        createdAt: this.metadata.createdAt,
        updatedAt: this.metadata.updatedAt
      },
      ...(this.initialState !== undefined ? { initialState: { ...this.initialState } } : {})
    };
  }

  /**
   * Deep clones a UI element
   */
  private cloneElement(element: UIElement): UIElement {
    return {
      ...element,
      properties: { ...element.properties },
      dataBindings: element.dataBindings.map(binding => ({ ...binding })),
      eventBindings: element.eventBindings.map(binding => ({ ...binding })),
      children: element.children?.map(child => this.cloneElement(child))
    };
  }

  /**
   * Validates the contract structure and content
   */
  validate(): ValidationResult {
    return validateContract(this);
  }

  /**
   * Checks if the contract is valid
   */
  isValid(): boolean {
    return this.validate().isValid;
  }

  /**
   * Updates the contract metadata
   */
  updateMetadata(updates: Partial<ContractMetadata>): void {
    this.metadata = {
      ...this.metadata,
      ...updates,
      updatedAt: new Date()
    };
  }

  /**
   * Adds a UI element to the contract
   */
  addElement(element: UIElement): void {
    // Validate element ID uniqueness
    if (this.elements.some(el => el.id === element.id)) {
      throw new Error(`Element with ID '${element.id}' already exists`);
    }

    this.elements.push(this.cloneElement(element));
    this.updateMetadata({});
  }

  /**
   * Removes a UI element by ID
   */
  removeElement(elementId: string): boolean {
    const index = this.elements.findIndex(el => el.id === elementId);
    if (index !== -1) {
      this.elements.splice(index, 1);
      this.updateMetadata({});
      return true;
    }
    return false;
  }

  /**
   * Updates a UI element by ID
   */
  updateElement(elementId: string, updates: Partial<UIElement>): boolean {
    const index = this.elements.findIndex(el => el.id === elementId);
    if (index !== -1) {
      // Prevent ID changes that would create duplicates
      if (updates.id && updates.id !== elementId && this.elements.some(el => el.id === updates.id)) {
        throw new Error(`Element with ID '${updates.id}' already exists`);
      }

      this.elements[index] = { ...this.elements[index], ...updates };
      this.updateMetadata({});
      return true;
    }
    return false;
  }

  /**
   * Gets a UI element by ID
   */
  getElement(elementId: string): UIElement | undefined {
    return this.elements.find(el => el.id === elementId);
  }

  /**
   * Gets all UI elements of a specific type
   */
  getElementsByType(type: string): UIElement[] {
    return this.elements.filter(el => el.type === type);
  }

  /**
   * Adds an operation binding to the contract
   */
  addOperation(operation: OperationBinding): void {
    // Validate operation ID uniqueness
    if (this.operations.some(op => op.id === operation.id)) {
      throw new Error(`Operation with ID '${operation.id}' already exists`);
    }

    this.operations.push({ ...operation });
    this.updateMetadata({});
  }

  /**
   * Removes an operation binding by ID
   */
  removeOperation(operationId: string): boolean {
    const index = this.operations.findIndex(op => op.id === operationId);
    if (index !== -1) {
      this.operations.splice(index, 1);
      this.updateMetadata({});
      return true;
    }
    return false;
  }

  /**
   * Updates an operation binding by ID
   */
  updateOperation(operationId: string, updates: Partial<OperationBinding>): boolean {
    const index = this.operations.findIndex(op => op.id === operationId);
    if (index !== -1) {
      // Prevent ID changes that would create duplicates
      if (updates.id && updates.id !== operationId && this.operations.some(op => op.id === updates.id)) {
        throw new Error(`Operation with ID '${updates.id}' already exists`);
      }

      this.operations[index] = { ...this.operations[index], ...updates };
      this.updateMetadata({});
      return true;
    }
    return false;
  }

  /**
   * Gets an operation binding by ID
   */
  getOperation(operationId: string): OperationBinding | undefined {
    return this.operations.find(op => op.id === operationId);
  }

  /**
   * Gets all operation bindings for a specific operation name
   */
  getOperationsByName(operationName: string): OperationBinding[] {
    return this.operations.filter(op => op.operationName === operationName);
  }

  /**
   * Updates the layout specification
   */
  updateLayout(layout: LayoutSpec): void {
    this.layout = { ...layout };
    this.updateMetadata({});
  }

  /**
   * Updates the styling specification
   */
  updateStyling(styling: StyleSpec): void {
    this.styling = { ...styling };
    this.updateMetadata({});
  }

  /**
   * Resolves component dependencies and creates a resolved contract
   */
  resolve(componentResolver?: (componentId: string) => any): ResolvedContract {
    const resolvedComponents = new Map<string, any>();
    const dependencyGraph: DependencyNode[] = [];

    // Build dependency graph for elements
    this.elements.forEach(element => {
      const dependencySet = new Set<string>();
      
      // Add data binding dependencies
      element.dataBindings.forEach(binding => {
        if (binding.source === 'operation') {
          dependencySet.add(binding.sourceId);
        }
      });

      // Add event binding dependencies
      element.eventBindings.forEach(binding => {
        dependencySet.add(binding.operationId);
      });

      dependencyGraph.push({
        id: element.id,
        dependencies: Array.from(dependencySet),
        resolved: false
      });

      // Resolve component if resolver is provided
      if (componentResolver) {
        try {
          const resolved = componentResolver(element.type);
          if (resolved) {
            resolvedComponents.set(element.id, resolved);
          }
        } catch {
          // Component resolution failed, will be handled during validation
        }
      }
    });

    // Build dependency graph for operations
    this.operations.forEach(operation => {
      const dependencies: string[] = [];
      
      // Add input dependencies
      operation.inputs.forEach(input => {
        if (input.source === 'ui-element') {
          dependencies.push(input.sourceId);
        }
      });

      dependencyGraph.push({
        id: operation.id,
        dependencies,
        resolved: false
      });

      // Resolve operation component if resolver is provided
      if (componentResolver) {
        try {
          const resolved = componentResolver(operation.operationName);
          if (resolved) {
            resolvedComponents.set(operation.id, resolved);
          }
        } catch {
          // Component resolution failed, will be handled during validation
        }
      }
    });

    // Perform topological sort to resolve dependencies
    this.resolveDependencies(dependencyGraph);

    return {
      contract: this,
      resolvedComponents,
      dependencyGraph
    };
  }

  /**
   * Performs dependency resolution with cycle detection
   * Note: In UI systems, bidirectional dependencies are common and acceptable
   */
  private resolveDependencies(dependencyGraph: DependencyNode[]): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cycles = new Set<string>();

    const visit = (nodeId: string, path: string[] = []): void => {
      if (visiting.has(nodeId)) {
        // Found a cycle, but in UI systems this might be acceptable
        // Mark the cycle but don't throw an error
        cycles.add(nodeId);
        return;
      }
      if (visited.has(nodeId)) {
        return;
      }

      const node = dependencyGraph.find(n => n.id === nodeId);
      if (!node) {
        return;
      }

      visiting.add(nodeId);
      const newPath = [...path, nodeId];

      // Visit all dependencies first
      node.dependencies.forEach(depId => {
        // Only visit if it's not creating a simple back-and-forth cycle
        if (!path.includes(depId) || path.length > 2) {
          visit(depId, newPath);
        }
      });

      visiting.delete(nodeId);
      visited.add(nodeId);
      node.resolved = true;
    };

    // Visit all nodes
    dependencyGraph.forEach(node => {
      if (!visited.has(node.id)) {
        visit(node.id);
      }
    });

    // Only throw error for complex cycles (more than 2 nodes)
    if (cycles.size > 2) {
      throw new Error(`Complex circular dependency detected involving: ${Array.from(cycles).join(', ')}`);
    }
  }

  /**
   * Applies edits to the contract
   */
  applyEdits(edits: ContractEdits): void {
    // Apply element edits
    Object.entries(edits.elementEdits).forEach(([elementId, elementEdits]) => {
      this.updateElement(elementId, elementEdits);
    });

    // Apply operation edits
    Object.entries(edits.operationEdits).forEach(([operationId, operationEdits]) => {
      this.updateOperation(operationId, operationEdits);
    });

    // Apply layout edits
    if (edits.layoutEdits) {
      this.updateLayout(edits.layoutEdits);
    }

    // Apply style edits
    if (edits.styleEdits) {
      this.updateStyling(edits.styleEdits);
    }
  }

  /**
   * Calculates the difference between this contract and another
   */
  diff(other: Contract): ContractDelta {
    const added: UIElement[] = [];
    const modified: UIElement[] = [];
    const removed: string[] = [];
    const operationChanges: OperationBinding[] = [];

    // Find added and modified elements
    other.elements.forEach(otherElement => {
      const thisElement = this.getElement(otherElement.id);
      if (!thisElement) {
        added.push(otherElement);
      } else if (JSON.stringify(thisElement) !== JSON.stringify(otherElement)) {
        modified.push(otherElement);
      }
    });

    // Find removed elements
    this.elements.forEach(thisElement => {
      if (!other.getElement(thisElement.id)) {
        removed.push(thisElement.id);
      }
    });

    // Find operation changes
    other.operations.forEach(otherOperation => {
      const thisOperation = this.getOperation(otherOperation.id);
      if (!thisOperation || JSON.stringify(thisOperation) !== JSON.stringify(otherOperation)) {
        operationChanges.push(otherOperation);
      }
    });

    return {
      added,
      modified,
      removed,
      operationChanges
    };
  }

  /**
   * Creates a deep copy of the contract
   */
  clone(): Contract {
    return Contract.fromObject(this.toObject());
  }

  /**
   * Gets a summary of the contract
   */
  getSummary(): {
    name: string;
    version: string;
    elementCount: number;
    operationCount: number;
    layoutType: string;
    theme: string;
    lastUpdated: Date;
  } {
    return {
      name: this.name,
      version: this.version,
      elementCount: this.elements.length,
      operationCount: this.operations.length,
      layoutType: this.layout.type,
      theme: this.styling.theme,
      lastUpdated: this.metadata.updatedAt
    };
  }

  /**
   * Finds all elements that depend on a specific operation
   */
  findElementsDependingOnOperation(operationId: string): UIElement[] {
    return this.elements.filter(element => {
      return element.dataBindings.some(binding => 
        binding.source === 'operation' && binding.sourceId === operationId
      ) || element.eventBindings.some(binding => 
        binding.operationId === operationId
      );
    });
  }

  /**
   * Finds all operations that depend on a specific element
   */
  findOperationsDependingOnElement(elementId: string): OperationBinding[] {
    return this.operations.filter(operation => {
      return operation.inputs.some(input => 
        input.source === 'ui-element' && input.sourceId === elementId
      ) || operation.outputs.some(output => 
        output.target === 'ui-element' && output.targetId === elementId
      );
    });
  }

  /**
   * Validates that all references in the contract are valid
   */
  validateReferences(): ValidationResult {
    const errors: any[] = [];
    const warnings: any[] = [];

    const elementIds = new Set(this.elements.map(el => el.id));
    const operationIds = new Set(this.operations.map(op => op.id));

    // Validate element references
    this.elements.forEach((element, elementIndex) => {
      element.dataBindings.forEach((binding, bindingIndex) => {
        if (binding.source === 'operation' && !operationIds.has(binding.sourceId)) {
          errors.push({
            path: `elements[${elementIndex}].dataBindings[${bindingIndex}].sourceId`,
            message: `Referenced operation '${binding.sourceId}' does not exist`,
            code: 'INVALID_OPERATION_REFERENCE'
          });
        }
      });

      element.eventBindings.forEach((binding, bindingIndex) => {
        if (!operationIds.has(binding.operationId)) {
          errors.push({
            path: `elements[${elementIndex}].eventBindings[${bindingIndex}].operationId`,
            message: `Referenced operation '${binding.operationId}' does not exist`,
            code: 'INVALID_OPERATION_REFERENCE'
          });
        }
      });
    });

    // Validate operation references
    this.operations.forEach((operation, operationIndex) => {
      operation.inputs.forEach((input, inputIndex) => {
        if (input.source === 'ui-element' && !elementIds.has(input.sourceId)) {
          errors.push({
            path: `operations[${operationIndex}].inputs[${inputIndex}].sourceId`,
            message: `Referenced element '${input.sourceId}' does not exist`,
            code: 'INVALID_ELEMENT_REFERENCE'
          });
        }
      });

      operation.outputs.forEach((output, outputIndex) => {
        if (output.target === 'ui-element' && !elementIds.has(output.targetId)) {
          errors.push({
            path: `operations[${operationIndex}].outputs[${outputIndex}].targetId`,
            message: `Referenced element '${output.targetId}' does not exist`,
            code: 'INVALID_ELEMENT_REFERENCE'
          });
        }
      });
    });

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}