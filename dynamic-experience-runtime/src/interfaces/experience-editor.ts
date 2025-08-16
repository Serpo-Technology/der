/**
 * Experience Editor interface - Manual editing and conflict resolution
 * Requirements: 5.1, 5.2, 5.5, 5.6, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import { Blueprint } from '../types/blueprint';
import { Contract, ValidationResult } from '../types/contract';

export interface ExperienceEditor {
  editBlueprint(experienceId: string, blueprint: Blueprint): Promise<void>;
  editContract(experienceId: string, contract: Contract): Promise<ValidationResult>;
  regenerateWithPreservation(experienceId: string, sections: string[]): Promise<Contract>;
  resolveEditingConflicts(conflicts: EditingConflict[]): Promise<Resolution[]>;
  validateUserEdits(edits: UserEdit[]): ValidationResult;
  previewChanges(experienceId: string, changes: any): Promise<PreviewResult>;
}

export interface EditingConflict {
  type: 'ai-user-conflict' | 'dependency-conflict' | 'validation-conflict';
  location: string;
  aiSuggestion: any;
  userEdit: any;
  resolutionOptions: ResolutionOption[];
}

export interface ResolutionOption {
  id: string;
  description: string;
  action: 'keep-user' | 'keep-ai' | 'merge' | 'custom';
  preview?: any;
}

export interface Resolution {
  conflictId: string;
  selectedOption: string;
  customValue?: any;
}

export interface UserEdit {
  location: string;
  originalValue: any;
  newValue: any;
  timestamp: Date;
  preserved: boolean;
}

export interface PreviewResult {
  isValid: boolean;
  preview: any;
  warnings: string[];
  errors: string[];
}

export interface EditTracker {
  trackEdit(edit: UserEdit): void;
  getEdits(location?: string): UserEdit[];
  clearEdits(location?: string): void;
  preserveEdits(edits: UserEdit[]): void;
}

export interface ConflictResolver {
  detectConflicts(aiChanges: any, userEdits: UserEdit[]): EditingConflict[];
  resolveConflict(conflict: EditingConflict, resolution: Resolution): any;
  mergeChanges(aiChanges: any, userEdits: UserEdit[]): any;
}