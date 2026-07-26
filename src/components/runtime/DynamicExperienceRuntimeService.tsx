/**
 * Dynamic Experience Runtime Service - Main service for managing experiences
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 9.1, 9.2, 9.3, 9.4
 */

import React from 'react';
import { Contract, ContractDelta, UIElement, EventBinding } from '../../types/contract';
import { Experience, ExperienceState } from '../../types/experience';
import { DynamicExperienceRuntime } from '../../interfaces/dynamic-runtime';
import { CoreExperienceRenderer } from './CoreExperienceRenderer';
import { ExperienceStateManager } from './ExperienceStateManager';
import { PersistenceService } from '../../services/persistence/PersistenceService';
import { emit } from '@tauri-apps/api/event';

export class DynamicExperienceRuntimeService implements DynamicExperienceRuntime {
  private experiences: Map<string, Experience> = new Map();
  private stateManagers: Map<string, ExperienceStateManager> = new Map();
  private persistenceService: PersistenceService = new PersistenceService();

  async renderExperience(contract: Contract, experienceId?: string): Promise<React.ComponentType> {
    const expId = experienceId || this.generateExperienceId(contract);
    
    // Create state manager for this experience
    const stateManager = new ExperienceStateManager(expId);
    this.stateManagers.set(expId, stateManager);

    // Create the React component
    const ExperienceComponent: React.ComponentType = (props: any) => {
      return React.createElement(CoreExperienceRenderer, {
        contract,
        experienceId: expId,
        onStateChange: (state: ExperienceState) => {
          this.handleStateChange(expId, state);
        },
        onError: (error: Error) => {
          this.handleExperienceError(expId, error);
        },
        ...props
      });
    };

    // Create experience record
    const experience: Experience = {
      id: expId,
      contract,
      reactComponent: ExperienceComponent,
      state: await stateManager.initializeState(contract),
      operations: this.extractOperationsMap(contract),
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: contract.version || '1.0.0'
      }
    };

    this.experiences.set(expId, experience);
    
    return ExperienceComponent;
  }

  async updateExperience(experience: Experience, changes: ContractDelta): Promise<void> {
    const stateManager = this.stateManagers.get(experience.id);
    if (!stateManager) {
      throw new Error(`State manager not found for experience ${experience.id}`);
    }

    try {
      // Apply contract changes
      const updatedContract = this.applyContractDelta(experience.contract, changes);
      
      // Update experience record
      experience.contract = updatedContract;
      experience.operations = this.extractOperationsMap(updatedContract);
      
      // Reinitialize state with new contract structure
      const newState = await stateManager.initializeState(updatedContract);
      
      // Preserve existing data where possible
      this.preserveExistingState(stateManager, newState);
      
      // Update the experience in our registry
      this.experiences.set(experience.id, experience);
      
    } catch (error) {
      console.error(`Error updating experience ${experience.id}:`, error);
      throw error;
    }
  }

  async executeOperation(): Promise<never> {
    throw new Error('Operations run in the runtime core sessions now');
  }


  bindEventHandlers(element: UIElement, bindings: EventBinding[]): void {
    // Event handlers are bound during rendering in ComponentRenderer
    // This method is for programmatic binding if needed
    console.log(`Binding ${bindings.length} event handlers to element ${element.id}`);
  }

  getExperienceState(experienceId: string): ExperienceState | null {
    const stateManager = this.stateManagers.get(experienceId);
    return stateManager ? stateManager.getState() : null;
  }

  async destroyExperience(experienceId: string): Promise<void> {
    // Clean up experience resources
    this.experiences.delete(experienceId);
    this.stateManagers.delete(experienceId);
    
    console.log(`Experience ${experienceId} destroyed`);
  }

  // Helper methods

  private generateExperienceId(contract: Contract): string {
    const timestamp = Date.now();
    const hash = this.simpleHash(JSON.stringify(contract));
    return `exp_${contract.name}_${timestamp}_${hash}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  private extractOperationsMap(contract: Contract): Map<string, any> {
    const operationsMap = new Map();
    
    contract.operations.forEach(operation => {
      operationsMap.set(operation.id, {
        id: operation.id,
        name: operation.operationName,
        inputs: operation.inputs,
        outputs: operation.outputs,
        triggers: operation.triggers
      });
    });

    return operationsMap;
  }

  private applyContractDelta(contract: Contract, changes: ContractDelta): Contract {
    const updatedContract = { ...contract };
    
    // Apply element changes
    updatedContract.elements = [...contract.elements];
    
    // Remove deleted elements
    changes.removed.forEach(elementId => {
      updatedContract.elements = updatedContract.elements.filter(el => el.id !== elementId);
    });
    
    // Add new elements
    updatedContract.elements.push(...changes.added);
    
    // Update modified elements
    changes.modified.forEach(modifiedElement => {
      const index = updatedContract.elements.findIndex(el => el.id === modifiedElement.id);
      if (index !== -1) {
        updatedContract.elements[index] = modifiedElement;
      }
    });
    
    // Update operations
    updatedContract.operations = [...contract.operations];
    changes.operationChanges.forEach(operationChange => {
      const index = updatedContract.operations.findIndex(op => op.id === operationChange.id);
      if (index !== -1) {
        updatedContract.operations[index] = operationChange;
      } else {
        updatedContract.operations.push(operationChange);
      }
    });

    return updatedContract;
  }

  private preserveExistingState(stateManager: ExperienceStateManager, newState: ExperienceState): void {
    const currentState = stateManager.getState();
    
    // Preserve data that still exists in the new state structure
    Object.keys(currentState.data).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(newState.data, key)) {
        newState.data[key] = currentState.data[key];
      }
    });
    
    // Update state manager with preserved data
    stateManager.updateState(newState);
  }

  private handleStateChange(experienceId: string, state: ExperienceState): void {
    const experience = this.experiences.get(experienceId);
    if (experience) {
      experience.state = state;
    }
  }

  private handleExperienceError(experienceId: string, error: Error): void {
    console.error(`Experience ${experienceId} error:`, error);
    
    // Could implement error recovery strategies here
    // For now, just log the error
  }

  // Public API for getting all experiences (useful for debugging)
  getAllExperiences(): Experience[] {
    return Array.from(this.experiences.values());
  }

  // Get experience by ID
  getExperience(experienceId: string): Experience | null {
    return this.experiences.get(experienceId) || null;
  }

  // Clear all experiences
  clearAllExperiences(): void {
    this.experiences.clear();
    this.stateManagers.clear();
  }

  // Persistence integration methods
  async saveExperience(experienceId: string): Promise<void> {
    const experience = this.experiences.get(experienceId);
    if (!experience) {
      throw new Error(`Experience ${experienceId} not found`);
    }

    await this.persistenceService.saveExperience(experience);
  }

  async loadExperience(experienceId: string): Promise<Experience> {
    const experience = await this.persistenceService.loadExperience(experienceId);
    
    if (!experience) {
      throw new Error(`Experience ${experienceId} not found in persistence`);
    }
    
    // Restore the experience in runtime
    const stateManager = new ExperienceStateManager(experienceId);
    this.stateManagers.set(experienceId, stateManager);
    
    // Recreate the React component
    const ExperienceComponent: React.ComponentType = (props: any) => {
      return React.createElement(CoreExperienceRenderer, {
        contract: experience.contract,
        experienceId,
        onStateChange: (state: ExperienceState) => {
          this.handleStateChange(experienceId, state);
        },
        onError: (error: Error) => {
          this.handleExperienceError(experienceId, error);
        },
        ...props
      });
    };

    experience.reactComponent = ExperienceComponent;
    this.experiences.set(experienceId, experience);
    
    return experience;
  }

  async updateExperienceState(experienceId: string, stateUpdate: Partial<ExperienceState>): Promise<void> {
    const stateManager = this.stateManagers.get(experienceId);
    if (!stateManager) {
      throw new Error(`State manager not found for experience ${experienceId}`);
    }

    const currentState = stateManager.getState();
    const newState = { ...currentState, ...stateUpdate, lastUpdated: new Date() };
    
    stateManager.updateState(newState);
    
    // Update the experience record
    const experience = this.experiences.get(experienceId);
    if (experience) {
      experience.state = newState;
    }
  }

  async updateExperienceContract(experienceId: string, contract: Contract): Promise<void> {
    const experience = this.experiences.get(experienceId);
    if (!experience) {
      throw new Error(`Experience ${experienceId} not found`);
    }

    const stateManager = this.stateManagers.get(experienceId);
    if (!stateManager) {
      throw new Error(`State manager not found for experience ${experienceId}`);
    }

    try {
      // Update experience record
      experience.contract = contract;
      experience.operations = this.extractOperationsMap(contract);
      
      // Ensure metadata exists and update timestamp
      if (!experience.metadata) {
        experience.metadata = {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: contract.version || '1.0.0'
        };
      } else {
        experience.metadata.updatedAt = new Date();
      }
      
      // Reinitialize state with new contract structure
      const newState = await stateManager.initializeState(contract);
      
      // Preserve existing data where possible
      this.preserveExistingState(stateManager, newState);
      
      // Update the experience in our registry
      this.experiences.set(experienceId, experience);
      
      // Emit cross-window update event so standalone windows can update
      try {
        await emit('experience-contract-updated', { experienceId, contract });
      } catch {
        // Cross-window notification is best-effort
      }
    } catch (error) {
      console.error(`Error updating experience ${experienceId}:`, error);
      throw error;
    }
  }

  async cleanupExperience(experienceId: string): Promise<void> {
    // Clean up experience resources
    this.experiences.delete(experienceId);
    this.stateManagers.delete(experienceId);
    
    console.log(`Experience ${experienceId} destroyed`);
  }
}

// Singleton instance for global use
export const dynamicExperienceRuntimeService = new DynamicExperienceRuntimeService();

export default DynamicExperienceRuntimeService;