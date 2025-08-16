/**
 * Experience State Manager - Manages state for dynamic experiences
 * Requirements: 3.1, 3.2, 9.1
 */

import { Contract, OutputBinding } from '../../types/contract';
import { ExperienceState } from '../../types/experience';

type StateChangeCallback = (newState: ExperienceState) => void;

export class ExperienceStateManager {
  private state: ExperienceState;
  private callbacks: Set<StateChangeCallback> = new Set();

  constructor(private experienceId: string) {
    this.state = {
      data: {},
      loading: {},
      errors: {},
      lastUpdated: new Date()
    };
  }

  async initializeState(contract: Contract): Promise<ExperienceState> {
    // Initialize state with default values from contract
    const initialData: Record<string, any> = {};
    const initialLoading: Record<string, boolean> = {};
    const initialErrors: Record<string, Error> = {};

    // Initialize operation states
    contract.operations.forEach(operation => {
      initialLoading[operation.id] = false;
      // Initialize output placeholders
      operation.outputs.forEach(output => {
        const key = `operation_${operation.id}_${output.name}`;
        initialData[key] = null;
      });
    });

    // Initialize UI element states
    this.initializeElementStates(contract.elements, initialData);

    this.state = {
      data: initialData,
      loading: initialLoading,
      errors: initialErrors,
      lastUpdated: new Date()
    };

    this.notifyStateChange();
    return this.state;
  }

  private initializeElementStates(elements: any[], data: Record<string, any>): void {
    elements.forEach(element => {
      // Initialize element-specific state
      if (element.properties?.defaultValue !== undefined) {
        data[`element_${element.id}`] = element.properties.defaultValue;
      }

      // Initialize child elements
      if (element.children) {
        this.initializeElementStates(element.children, data);
      }
    });
  }

  getState(): ExperienceState {
    return { ...this.state };
  }

  updateState(updates: Partial<ExperienceState>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdated: new Date()
    };
    this.notifyStateChange();
  }

  setData(key: string, value: any): void {
    this.state.data[key] = value;
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
  }

  getData(key: string): any {
    return this.state.data[key];
  }

  setLoading(operationId: string, loading: boolean): void {
    this.state.loading[operationId] = loading;
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
  }

  isLoading(operationId: string): boolean {
    return this.state.loading[operationId] || false;
  }

  setError(operationId: string, error: Error): void {
    this.state.errors[operationId] = error;
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
  }

  getError(operationId: string): Error | null {
    return this.state.errors[operationId] || null;
  }

  clearError(operationId: string): void {
    delete this.state.errors[operationId];
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
  }

  updateStateFromOperationResult(
    operationId: string, 
    result: any, 
    outputs: OutputBinding[]
  ): void {
    // Clear any existing errors for this operation
    this.clearError(operationId);

    // Update state based on operation outputs
    outputs.forEach(output => {
      const resultValue = this.extractResultValue(result, output.name);
      
      if (output.target === 'state') {
        // Update global state
        this.setData(output.targetId, resultValue);
      } else if (output.target === 'ui-element') {
        // Update UI element property
        const elementKey = `element_${output.targetId}`;
        if (output.property) {
          const elementData = this.getData(elementKey);
          // Ensure elementData is an object, not a primitive value
          const elementObject = typeof elementData === 'object' && elementData !== null 
            ? elementData 
            : { value: elementData };
          elementObject[output.property] = resultValue;
          this.setData(elementKey, elementObject);
        } else {
          this.setData(elementKey, resultValue);
        }
      }

      // Also store the raw operation result
      const operationResultKey = `operation_${operationId}_${output.name}`;
      this.setData(operationResultKey, resultValue);
    });
  }

  private extractResultValue(result: any, outputName: string): any {
    if (result && typeof result === 'object') {
      return result[outputName] !== undefined ? result[outputName] : result;
    }
    return result;
  }

  subscribeToStateChanges(callback: StateChangeCallback): () => void {
    this.callbacks.add(callback);
    
    // Return unsubscribe function
    return () => {
      this.callbacks.delete(callback);
    };
  }

  private notifyStateChange(): void {
    const currentState = this.getState();
    this.callbacks.forEach(callback => {
      try {
        callback(currentState);
      } catch (error) {
        console.error('Error in state change callback:', error);
      }
    });
  }

  // Batch state updates for performance
  batchUpdate(updates: () => void): void {
    const originalNotify = this.notifyStateChange;
    this.notifyStateChange = () => {}; // Temporarily disable notifications

    try {
      updates();
    } finally {
      this.notifyStateChange = originalNotify;
      this.notifyStateChange(); // Send single notification after all updates
    }
  }

  // Reset state to initial values
  reset(): void {
    this.state = {
      data: {},
      loading: {},
      errors: {},
      lastUpdated: new Date()
    };
    this.notifyStateChange();
  }

  // Get state snapshot for debugging
  getStateSnapshot(): any {
    return {
      experienceId: this.experienceId,
      state: this.getState(),
      callbackCount: this.callbacks.size
    };
  }
}

export default ExperienceStateManager;