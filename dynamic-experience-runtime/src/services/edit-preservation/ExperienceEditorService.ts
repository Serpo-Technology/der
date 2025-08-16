/**
 * Experience Editor Service - Main service for edit preservation and conflict resolution
 * Requirements: 5.1, 5.2, 5.5, 5.6, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import { 
  ExperienceEditor, 
  EditingConflict, 
  Resolution, 
  UserEdit, 
  PreviewResult 
} from '../../interfaces/experience-editor';
import { Blueprint } from '../../types/blueprint';
import { Contract, ValidationResult } from '../../types/contract';
import { EditTracker } from './EditTracker';
import { ConflictResolver } from './ConflictResolver';

export class ExperienceEditorService implements ExperienceEditor {
  private editTracker: EditTracker;
  private conflictResolver: ConflictResolver;
  private experiences: Map<string, ExperienceData> = new Map();

  constructor() {
    this.editTracker = new EditTracker();
    this.conflictResolver = new ConflictResolver();
  }

  /**
   * Edits a blueprint for an experience
   */
  async editBlueprint(experienceId: string, blueprint: Blueprint): Promise<void> {
    const experience = this.getOrCreateExperience(experienceId);
    const originalBlueprint = experience.blueprint;

    // Track the edit
    const edit: UserEdit = {
      location: `blueprint`,
      originalValue: originalBlueprint,
      newValue: blueprint,
      timestamp: new Date(),
      preserved: false
    };

    this.editTracker.trackEdit(edit);

    // Update the experience
    experience.blueprint = blueprint;
    experience.lastModified = new Date();

    this.experiences.set(experienceId, experience);
  }

  /**
   * Edits a contract for an experience
   */
  async editContract(experienceId: string, contract: Contract): Promise<ValidationResult> {
    const experience = this.getOrCreateExperience(experienceId);
    const originalContract = experience.contract;

    // Track the edit
    const edit: UserEdit = {
      location: `contract`,
      originalValue: originalContract?.toObject(),
      newValue: contract.toObject(),
      timestamp: new Date(),
      preserved: false
    };

    this.editTracker.trackEdit(edit);

    // Validate the contract
    const validationResult = contract.validate();
    const referenceValidation = contract.validateReferences();

    const combinedValidation: ValidationResult = {
      isValid: validationResult.isValid && referenceValidation.isValid,
      errors: [...validationResult.errors, ...referenceValidation.errors],
      warnings: [...validationResult.warnings, ...referenceValidation.warnings]
    };

    // Update the experience if valid
    if (combinedValidation.isValid) {
      experience.contract = contract;
      experience.lastModified = new Date();
      this.experiences.set(experienceId, experience);
    }

    return combinedValidation;
  }

  /**
   * Regenerates sections while preserving user edits
   */
  async regenerateWithPreservation(experienceId: string, sections: string[]): Promise<Contract> {
    const experience = this.getOrCreateExperience(experienceId);
    if (!experience.contract) {
      throw new Error(`No contract found for experience ${experienceId}`);
    }

    // Get preserved edits
    const preservedEdits = this.editTracker.getPreservedEdits();
    
    // Simulate AI regeneration (in real implementation, this would call the AI service)
    const aiGeneratedContract = await this.simulateAIRegeneration(
      experience.contract, 
      sections,
      experience.blueprint
    );

    // Detect conflicts
    const conflicts = this.conflictResolver.detectConflicts(
      aiGeneratedContract.toObject(),
      preservedEdits
    );

    if (conflicts.length > 0) {
      // Store conflicts for resolution
      experience.pendingConflicts = conflicts;
      this.experiences.set(experienceId, experience);
      
      // Return the original contract until conflicts are resolved
      return experience.contract;
    }

    // Merge AI changes with preserved edits
    const mergedContractData = this.conflictResolver.mergeChanges(
      aiGeneratedContract.toObject(),
      preservedEdits
    );

    const mergedContract = Contract.fromObject(mergedContractData);
    
    // Update experience
    experience.contract = mergedContract;
    experience.lastModified = new Date();
    this.experiences.set(experienceId, experience);

    return mergedContract;
  }

  /**
   * Resolves editing conflicts
   */
  async resolveEditingConflicts(conflicts: EditingConflict[]): Promise<Resolution[]> {
    const resolutions: Resolution[] = [];

    for (const conflict of conflicts) {
      // For now, we'll auto-resolve with user preference
      // In a real implementation, this would present options to the user
      const resolution: Resolution = {
        conflictId: conflict.location,
        selectedOption: 'keep-user' // Default to keeping user edits
      };

      resolutions.push(resolution);
    }

    return resolutions;
  }

  /**
   * Validates user edits
   */
  validateUserEdits(edits: UserEdit[]): ValidationResult {
    const errors: any[] = [];
    const warnings: any[] = [];

    edits.forEach((edit, index) => {
      // Validate edit structure
      if (!edit.location) {
        errors.push({
          path: `edits[${index}].location`,
          message: 'Edit location is required',
          code: 'MISSING_LOCATION'
        });
      }

      if (edit.newValue === undefined) {
        warnings.push({
          path: `edits[${index}].newValue`,
          message: 'Edit has undefined new value',
          code: 'UNDEFINED_VALUE'
        });
      }

      // Validate timestamp
      if (!(edit.timestamp instanceof Date) || isNaN(edit.timestamp.getTime())) {
        errors.push({
          path: `edits[${index}].timestamp`,
          message: 'Invalid timestamp',
          code: 'INVALID_TIMESTAMP'
        });
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Previews changes before applying them
   */
  async previewChanges(experienceId: string, changes: any): Promise<PreviewResult> {
    const experience = this.getOrCreateExperience(experienceId);
    
    try {
      // Create a preview contract
      let previewContract: Contract;
      
      if (experience.contract) {
        previewContract = experience.contract.clone();
        
        // Apply changes to preview
        if (changes.elements) {
          changes.elements.forEach((element: any) => {
            if (element.id) {
              previewContract.updateElement(element.id, element);
            }
          });
        }
        
        if (changes.operations) {
          changes.operations.forEach((operation: any) => {
            if (operation.id) {
              previewContract.updateOperation(operation.id, operation);
            }
          });
        }
      } else {
        previewContract = Contract.fromObject(changes);
      }

      // Validate the preview
      const validation = previewContract.validate();
      const referenceValidation = previewContract.validateReferences();

      const warnings: string[] = [
        ...validation.warnings.map(w => w.message),
        ...referenceValidation.warnings.map(w => w.message)
      ];

      const errors: string[] = [
        ...validation.errors.map(e => e.message),
        ...referenceValidation.errors.map(e => e.message)
      ];

      return {
        isValid: validation.isValid && referenceValidation.isValid,
        preview: previewContract.toObject(),
        warnings,
        errors
      };
    } catch (error) {
      return {
        isValid: false,
        preview: null,
        warnings: [],
        errors: [error instanceof Error ? error.message : 'Unknown preview error']
      };
    }
  }

  /**
   * Gets edit statistics for an experience
   */
  getEditStats(experienceId: string): any {
    const experience = this.experiences.get(experienceId);
    if (!experience) {
      return { totalEdits: 0, preservedEdits: 0, pendingConflicts: 0 };
    }

    const stats = this.editTracker.getEditStats();
    return {
      ...stats,
      pendingConflicts: experience.pendingConflicts?.length || 0,
      lastModified: experience.lastModified
    };
  }

  /**
   * Gets pending conflicts for an experience
   */
  getPendingConflicts(experienceId: string): EditingConflict[] {
    const experience = this.experiences.get(experienceId);
    return experience?.pendingConflicts || [];
  }

  /**
   * Applies conflict resolutions
   */
  async applyConflictResolutions(
    experienceId: string, 
    resolutions: Resolution[]
  ): Promise<Contract> {
    const experience = this.getOrCreateExperience(experienceId);
    if (!experience.contract || !experience.pendingConflicts) {
      throw new Error(`No pending conflicts for experience ${experienceId}`);
    }

    let resolvedContract = experience.contract.clone();

    // Apply each resolution
    for (const resolution of resolutions) {
      const conflict = experience.pendingConflicts.find(
        c => c.location === resolution.conflictId
      );

      if (conflict) {
        const resolvedValue = this.conflictResolver.resolveConflict(conflict, resolution);
        
        // Apply the resolved value to the contract
        this.applyValueToContract(resolvedContract, conflict.location, resolvedValue);
      }
    }

    // Clear pending conflicts
    experience.pendingConflicts = [];
    experience.contract = resolvedContract;
    experience.lastModified = new Date();
    
    this.experiences.set(experienceId, experience);

    return resolvedContract;
  }

  /**
   * Preserves specific edits
   */
  preserveEdits(experienceId: string, editLocations: string[]): void {
    const editsToPreserve = this.editTracker.getEdits().filter(
      edit => editLocations.includes(edit.location)
    );

    this.editTracker.preserveEdits(editsToPreserve);
  }

  /**
   * Gets or creates an experience data object
   */
  private getOrCreateExperience(experienceId: string): ExperienceData {
    let experience = this.experiences.get(experienceId);
    
    if (!experience) {
      experience = {
        id: experienceId,
        blueprint: undefined,
        contract: undefined,
        lastModified: new Date(),
        pendingConflicts: []
      };
      this.experiences.set(experienceId, experience);
    }

    return experience;
  }

  /**
   * Simulates AI regeneration (placeholder for actual AI service)
   */
  private async simulateAIRegeneration(
    currentContract: Contract,
    sections: string[],
    blueprint?: Blueprint
  ): Promise<Contract> {
    // This is a placeholder - in real implementation, this would call the AI service
    const regeneratedContract = currentContract.clone();
    
    // Simulate some AI changes
    if (sections.includes('metadata')) {
      regeneratedContract.updateMetadata({
        description: 'AI updated description',
        updatedAt: new Date()
      });
    }

    return regeneratedContract;
  }

  /**
   * Applies a resolved value to a contract at a specific location
   */
  private applyValueToContract(contract: Contract, location: string, value: any): void {
    const parts = location.split('.');
    
    if (parts[0] === 'contract') {
      // Handle contract-level changes
      if (parts[1] === 'name') {
        contract.name = value;
      } else if (parts[1] === 'version') {
        contract.version = value;
      }
      // Add more contract property handling as needed
    }
    
    // Handle element changes
    if (parts[0] === 'elements' && parts[1]) {
      const elementId = parts[1];
      const element = contract.getElement(elementId);
      if (element && parts[2]) {
        const property = parts[2];
        (element as any)[property] = value;
        contract.updateElement(elementId, element);
      }
    }

    // Handle operation changes
    if (parts[0] === 'operations' && parts[1]) {
      const operationId = parts[1];
      const operation = contract.getOperation(operationId);
      if (operation && parts[2]) {
        const property = parts[2];
        (operation as any)[property] = value;
        contract.updateOperation(operationId, operation);
      }
    }
  }
}

interface ExperienceData {
  id: string;
  blueprint?: Blueprint;
  contract?: Contract;
  lastModified: Date;
  pendingConflicts?: EditingConflict[];
}