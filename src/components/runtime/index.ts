/**
 * Dynamic Experience Runtime Components
 * Requirements: 3.1, 3.2, 3.5, 9.1, 9.2, 9.3, 9.4
 */

export { ComponentRenderer } from './ComponentRenderer';
export { ExperienceStateManager } from './ExperienceStateManager';
export { DynamicExperienceRuntimeService, dynamicExperienceRuntimeService } from './DynamicExperienceRuntimeService';

// Real-time update components
export { ContractChangeDetector } from './ContractChangeDetector';

// Re-export types for convenience
export type { Experience, ExperienceState } from '../../types/experience';
export type { Contract, UIElement, ContractDelta } from '../../types/contract';
export type { ContractChange, ContractChangeAnalysis } from './ContractChangeDetector';
