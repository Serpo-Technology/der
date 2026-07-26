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

