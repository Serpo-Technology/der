/**
 * Blueprint model with JSON serialization
 * Requirements: 1.2, 1.3
 */

import type { 
  Blueprint as IBlueprintInterface,
  UIElementRequirement,
  OperationRequirement,
  Ambiguity,
  UserModification,
  ValidationResult
} from '../types';
import { validateBlueprint } from '../utils/validation';

export class Blueprint implements IBlueprintInterface {
  public description: string;
  public goal: string;
  public intent: string;
  public confidence: number;
  public feedback?: string;
  public requiredCapabilities: string[];
  public uiElements: UIElementRequirement[];
  public operations: OperationRequirement[];
  public ambiguities: Ambiguity[];
  public userModifications?: UserModification[];

  constructor(data: Partial<IBlueprintInterface> = {}) {
    this.description = data.description || '';
    this.goal = data.goal || '';
    this.intent = (data as any).intent || data.description || '';
    this.confidence = (data as any).confidence || 1.0;
    this.feedback = (data as any).feedback;
    this.requiredCapabilities = data.requiredCapabilities || [];
    this.uiElements = data.uiElements || [];
    this.operations = data.operations || [];
    this.ambiguities = data.ambiguities || [];
    this.userModifications = data.userModifications;
  }

  /**
   * Creates a Blueprint instance from a natural language description
   */
  static fromDescription(description: string): Blueprint {
    return new Blueprint({
      description,
      goal: '',
      requiredCapabilities: [],
      uiElements: [],
      operations: [],
      ambiguities: []
    });
  }

  /**
   * Creates a Blueprint instance from JSON data
   */
  static fromJSON(json: string): Blueprint {
    try {
      const data = JSON.parse(json);
      return Blueprint.fromObject(data);
    } catch (error) {
      throw new Error(`Invalid JSON format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Creates a Blueprint instance from a plain object
   */
  static fromObject(data: any): Blueprint {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid blueprint data: must be an object');
    }

    // Convert date strings back to Date objects for user modifications
    const userModifications = data.userModifications?.map((mod: any) => ({
      ...mod,
      timestamp: mod.timestamp ? new Date(mod.timestamp) : new Date()
    }));

    return new Blueprint({
      description: data.description,
      goal: data.goal,
      requiredCapabilities: data.requiredCapabilities,
      uiElements: data.uiElements,
      operations: data.operations,
      ambiguities: data.ambiguities,
      userModifications
    });
  }

  /**
   * Serializes the blueprint to JSON string
   */
  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  /**
   * Converts the blueprint to a plain object
   */
  toObject(): IBlueprintInterface {
    return {
      description: this.description,
      goal: this.goal,
      requiredCapabilities: [...this.requiredCapabilities],
      uiElements: this.uiElements.map(element => ({ ...element })),
      operations: this.operations.map(operation => ({ ...operation })),
      ambiguities: this.ambiguities.map(ambiguity => ({ ...ambiguity })),
      userModifications: this.userModifications?.map(mod => ({
        ...mod,
        timestamp: mod.timestamp
      }))
    };
  }

  /**
   * Validates the blueprint structure and content
   */
  validate(): ValidationResult {
    return validateBlueprint(this);
  }

  /**
   * Checks if the blueprint is valid
   */
  isValid(): boolean {
    return this.validate().isValid;
  }

  /**
   * Adds a UI element requirement to the blueprint
   */
  addUIElement(element: UIElementRequirement): void {
    this.uiElements.push({ ...element });
  }

  /**
   * Removes a UI element requirement by index
   */
  removeUIElement(index: number): boolean {
    if (index >= 0 && index < this.uiElements.length) {
      this.uiElements.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Updates a UI element requirement at the specified index
   */
  updateUIElement(index: number, element: Partial<UIElementRequirement>): boolean {
    if (index >= 0 && index < this.uiElements.length) {
      this.uiElements[index] = { ...this.uiElements[index], ...element };
      return true;
    }
    return false;
  }

  /**
   * Adds an operation requirement to the blueprint
   */
  addOperation(operation: OperationRequirement): void {
    this.operations.push({ ...operation });
  }

  /**
   * Removes an operation requirement by index
   */
  removeOperation(index: number): boolean {
    if (index >= 0 && index < this.operations.length) {
      this.operations.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Updates an operation requirement at the specified index
   */
  updateOperation(index: number, operation: Partial<OperationRequirement>): boolean {
    if (index >= 0 && index < this.operations.length) {
      this.operations[index] = { ...this.operations[index], ...operation };
      return true;
    }
    return false;
  }

  /**
   * Adds a required capability
   */
  addCapability(capability: string): void {
    if (!this.requiredCapabilities.includes(capability)) {
      this.requiredCapabilities.push(capability);
    }
  }

  /**
   * Removes a required capability
   */
  removeCapability(capability: string): boolean {
    const index = this.requiredCapabilities.indexOf(capability);
    if (index !== -1) {
      this.requiredCapabilities.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Adds an ambiguity that needs clarification
   */
  addAmbiguity(ambiguity: Ambiguity): void {
    this.ambiguities.push({ ...ambiguity });
  }

  /**
   * Removes an ambiguity by ID
   */
  removeAmbiguity(id: string): boolean {
    const index = this.ambiguities.findIndex(amb => amb.id === id);
    if (index !== -1) {
      this.ambiguities.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clears all ambiguities
   */
  clearAmbiguities(): void {
    this.ambiguities = [];
  }

  /**
   * Records a user modification
   */
  recordUserModification(location: string, originalValue: any, newValue: any): void {
    if (!this.userModifications) {
      this.userModifications = [];
    }

    this.userModifications.push({
      location,
      originalValue,
      newValue,
      timestamp: new Date(),
      preserved: true
    });
  }

  /**
   * Gets all user modifications for a specific location
   */
  getUserModifications(location?: string): UserModification[] {
    if (!this.userModifications) {
      return [];
    }

    if (location) {
      return this.userModifications.filter(mod => mod.location === location);
    }

    return [...this.userModifications];
  }

  /**
   * Checks if there are any unresolved ambiguities
   */
  hasAmbiguities(): boolean {
    return this.ambiguities.length > 0;
  }

  /**
   * Gets a summary of the blueprint
   */
  getSummary(): {
    description: string;
    goal: string;
    elementCount: number;
    operationCount: number;
    capabilityCount: number;
    ambiguityCount: number;
    hasUserModifications: boolean;
  } {
    return {
      description: this.description,
      goal: this.goal,
      elementCount: this.uiElements.length,
      operationCount: this.operations.length,
      capabilityCount: this.requiredCapabilities.length,
      ambiguityCount: this.ambiguities.length,
      hasUserModifications: Boolean(this.userModifications && this.userModifications.length > 0)
    };
  }

  /**
   * Creates a deep copy of the blueprint
   */
  clone(): Blueprint {
    return Blueprint.fromObject(this.toObject());
  }

  /**
   * Merges another blueprint into this one
   */
  merge(other: Blueprint): void {
    // Merge capabilities (avoid duplicates)
    other.requiredCapabilities.forEach(capability => {
      this.addCapability(capability);
    });

    // Merge UI elements
    other.uiElements.forEach(element => {
      this.addUIElement(element);
    });

    // Merge operations
    other.operations.forEach(operation => {
      this.addOperation(operation);
    });

    // Merge ambiguities
    other.ambiguities.forEach(ambiguity => {
      this.addAmbiguity(ambiguity);
    });

    // Update goal if this blueprint doesn't have one
    if (!this.goal && other.goal) {
      this.goal = other.goal;
    }

    // Update description if this blueprint doesn't have one
    if (!this.description && other.description) {
      this.description = other.description;
    }
  }
}