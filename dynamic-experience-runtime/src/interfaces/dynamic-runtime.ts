/**
 * Dynamic Experience Runtime interface - Experience rendering and execution
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 9.1, 9.2, 9.3, 9.4
 */

import React from 'react';
import { Contract, ContractDelta, UIElement, EventBinding } from '../types/contract';
import { Experience, ExperienceState } from '../types/experience';

export interface DynamicExperienceRuntime {
  renderExperience(contract: Contract): Promise<React.ComponentType>;
  updateExperience(experience: Experience, changes: ContractDelta): Promise<void>;
  executeOperation(operationId: string, inputs: any[]): Promise<any>;
  bindEventHandlers(element: UIElement, bindings: EventBinding[]): void;
  getExperienceState(experienceId: string): ExperienceState | null;
  destroyExperience(experienceId: string): Promise<void>;
}

export interface ComponentRenderer {
  renderUIElement(element: UIElement): React.ComponentType;
  updateUIElement(elementId: string, changes: Partial<UIElement>): void;
  bindDataToElement(elementId: string, data: any): void;
}

export interface OperationExecutor {
  executeRemoteOperation(operation: any, inputs: any[]): Promise<any>;
  executeLocalOperation(operation: any, inputs: any[]): Promise<any>;
  executeRepositoryOperation(operation: any, inputs: any[]): Promise<any>;
}

export interface StateManager {
  getState(experienceId: string): ExperienceState;
  updateState(experienceId: string, updates: Partial<ExperienceState>): void;
  subscribeToStateChanges(experienceId: string, callback: StateChangeCallback): () => void;
}

export interface StateChangeCallback {
  (newState: ExperienceState, previousState: ExperienceState): void;
}

// Tauri Command Interface for backend communication
export interface TauriCommands {
  execute_operation(operation: string, inputs: any[]): Promise<any>;
  save_contract(contract: Contract): Promise<string>;
  load_contract(id: string): Promise<Contract | null>;
  query_repository(criteria: any): Promise<any[]>;
  save_experience_state(experienceId: string, state: ExperienceState): Promise<void>;
  load_experience_state(experienceId: string): Promise<ExperienceState | null>;
}