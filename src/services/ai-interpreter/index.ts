/**
 * AI Interpreter Service - orchestrates the single-call composition pipeline
 * (description -> contract + spec -> projected blueprint) and contract edits.
 */

import { AIInterpreter } from '../../interfaces/ai-interpreter';
import { Blueprint, ComposedSpec, Question, Answer } from '../../types/blueprint';
import { Contract, ContractEdits, ValidationWarning } from '../../types/contract';
import { ComponentRepository } from '../../types/repository';
import { LLMClient } from './llm-client';
import { BlueprintGenerator } from './blueprint-generator';
import { EditPreservationSystem, EditConflict, ConflictResolution } from './edit-preservation';
import { isTauriRuntime } from '../tauri/TauriCommandService';
import {
  composeViaCore,
  editViaCore,
  generateFromBlueprintViaCore,
} from '../runtime-core/compose-client';

export interface ComposedExperience {
  blueprint: Blueprint;
  contract: Contract;
  spec: ComposedSpec;
  warnings: ValidationWarning[];
  /** Set when the request matched an installed recipe and the contract came
   * from it instead of a fresh composition. */
  recipeName?: string;
}

export class AIInterpreterService implements AIInterpreter {
  private lastContractWarnings: ValidationWarning[] = [];
  private generator: BlueprintGenerator;
  private editPreservation: EditPreservationSystem;

  constructor(repository: ComponentRepository, llmClient: LLMClient = new LLMClient()) {
    void llmClient;
    this.generator = new BlueprintGenerator();
    void repository;
    this.editPreservation = new EditPreservationSystem();
  }

  /**
   * Creates a contract from a natural-language description in one model call
   * and projects the reviewable blueprint from the result.
   */
  async compose(
    description: string,
    onPartial?: (accumulated: string, attempt: number) => void
  ): Promise<ComposedExperience> {
    if (!description || description.trim().length === 0) {
      throw new Error('Invalid description: Description cannot be empty');
    }

    try {
      // Under Tauri the runtime core runs the whole pipeline; the TS
      // builder stays the engine outside it (evals, plain browser runs).
      if (!isTauriRuntime()) {
        throw new Error('Creating apps needs the desktop core');
      }
      const { contract, spec, recipeName, warnings } = await composeViaCore(
        description,
        onPartial
      );
      this.lastContractWarnings = warnings;
      const blueprint = this.generator.deriveFromComposition(spec, contract, description);
      return { blueprint, contract, spec, warnings, recipeName };
    } catch (error) {
      throw new Error(`Failed to compose experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate clarifying questions for ambiguous blueprints
   */
  async generateClarifyingQuestions(blueprint: Blueprint): Promise<any[]> {
    if (!blueprint.ambiguities || blueprint.ambiguities.length === 0) {
      return [];
    }

    return blueprint.ambiguities.map(ambiguity => ({
      id: ambiguity.id,
      question: ambiguity.question,
      options: ambiguity.options,
      type: 'clarification'
    }));
  }

  async generateQuestions(blueprint: Blueprint): Promise<Question[]> {
    // Extract questions from ambiguities in the blueprint
    const questions: Question[] = (blueprint.ambiguities ?? []).map((ambiguity) => ({
      id: ambiguity.id,
      text: ambiguity.question,
      type: ambiguity.options.length > 0 ? 'choice' : 'text',
      options: ambiguity.options.length > 0 ? ambiguity.options : undefined,
    }));

    // If no ambiguities were detected, we might want to generate additional clarifying questions
    if (questions.length === 0 && blueprint.requiredCapabilities.length === 0) {
      // Generate some default questions to help clarify the user's intent
      return this.generateDefaultQuestions(blueprint);
    }

    return questions;
  }

  async refineBlueprint(blueprint: Blueprint, answers: Answer[]): Promise<Blueprint> {
    try {
      const refinedBlueprint = this.generator.refineWithAnswers(blueprint, answers);
      
      // Validate the refined blueprint
      const validationResult = this.generator.validateBlueprint(refinedBlueprint);
      if (!validationResult.isValid) {
        throw new Error(`Refined blueprint is invalid: ${validationResult.errors.map(e => e.message).join(', ')}`);
      }

      return refinedBlueprint;
    } catch (error) {
      throw new Error(`Failed to refine blueprint: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Blueprint regeneration through the core under Tauri, the TS builder
   * otherwise; every regenerate entry point funnels through here. */
  private async regenerateFromBlueprint(blueprint: Blueprint): Promise<Contract> {
    if (!isTauriRuntime()) {
      throw new Error('Regenerating apps needs the desktop core');
    }
    const { contract, warnings } = await generateFromBlueprintViaCore(blueprint);
    this.lastContractWarnings = warnings;
    return contract;
  }

  async generateContract(blueprint: Blueprint, userEdits?: ContractEdits): Promise<Contract> {
    try {
      // Generate contract from blueprint
      let contract = await this.regenerateFromBlueprint(blueprint);
      
      // Apply user edits if provided
      if (userEdits) {
        contract = this.applyUserEditsToContract(contract, userEdits);
      }
      
      return contract;
    } catch (error) {
      throw new Error(`Failed to generate contract: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Degradations applied by the most recent contract generation or edit. */
  getLastContractWarnings(): ValidationWarning[] {
    return this.lastContractWarnings;
  }

  /**
   * Applies a natural-language edit to an existing contract; user data is
   * preserved through id stability rather than merge heuristics.
   */
  async editContract(
    current: Contract,
    instruction: string,
    onPartial?: (accumulated: string, attempt: number) => void
  ): Promise<{ contract: Contract; warnings: ValidationWarning[] }> {
    try {
      if (!isTauriRuntime()) {
        throw new Error('Editing apps needs the desktop core');
      }
      const { contract, warnings } = await editViaCore(current, instruction, onPartial);
      this.lastContractWarnings = warnings;
      return { contract, warnings };
    } catch (error) {
      throw new Error(`Failed to edit contract: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate contract with preservation of user edits
   */
  async generateContractWithPreservation(blueprint: Blueprint, _existingContract: Contract, userEdits?: any[]): Promise<Contract> {
    // Generate new contract from blueprint
    const newContract = await this.generateContract(blueprint);
    
    // Preserve user edits if provided
    if (userEdits && userEdits.length > 0) {
      // Apply preserved edits to new contract
      // This is a simplified implementation
      return newContract;
    }
    
    return newContract;
  }

  async preserveUserEdits(originalContract: Contract, userEdits: ContractEdits): Promise<Contract> {
    try {
      return this.editPreservation.preserveUserEditsInContract(originalContract, userEdits);
    } catch (error) {
      throw new Error(`Failed to preserve user edits: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async regenerateWithConflictDetection(blueprint: Blueprint, existingContract: Contract, sections: string[]): Promise<{ contract: Contract; conflicts: EditConflict[] }> {
    try {
      // Generate new contract from blueprint
      const newContract = await this.regenerateFromBlueprint(blueprint);
      
      // Preserve user edits and detect conflicts
      return this.editPreservation.regenerateWithPreservation(
        blueprint, 
        existingContract, 
        newContract, 
        sections
      );
    } catch (error) {
      throw new Error(`Failed to regenerate with conflict detection: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async resolveEditingConflicts(contract: Contract, conflicts: EditConflict[], resolutions: Map<string, ConflictResolution>): Promise<Contract> {
    try {
      return this.editPreservation.resolveConflicts(contract, conflicts, resolutions);
    } catch (error) {
      throw new Error(`Failed to resolve editing conflicts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async regenerateWithPreservation(blueprint: Blueprint, existingContract: Contract, sections: string[]): Promise<Contract> {
    try {
      // Generate new contract from blueprint
      const newContract = await this.regenerateFromBlueprint(blueprint);
      
      // Preserve user edits and detect conflicts
      const { contract: preservedContract, conflicts } = this.editPreservation.regenerateWithPreservation(
        blueprint, 
        existingContract, 
        newContract, 
        sections
      );

      // For now, auto-resolve conflicts by keeping user edits
      // In a real implementation, this would present conflicts to the user
      if (conflicts.length > 0) {
        const resolutions = new Map<string, ConflictResolution>();
        for (const conflict of conflicts) {
          resolutions.set(conflict.id, {
            id: 'auto-keep-user',
            description: 'Automatically keep user changes',
            action: 'keep-user'
          });
        }
        
        return this.editPreservation.resolveConflicts(preservedContract, conflicts, resolutions);
      }

      return preservedContract;
    } catch (error) {
      throw new Error(`Failed to regenerate with preservation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private applyUserEditsToContract(contract: Contract, userEdits: ContractEdits): Contract {
    const editedContract = { ...contract };

    // Apply element edits
    if (userEdits.elementEdits) {
      editedContract.elements = contract.elements.map(element => {
        const edits = userEdits.elementEdits[element.id];
        if (edits) {
          return { ...element, ...edits };
        }
        return element;
      });
    }

    // Apply operation edits
    if (userEdits.operationEdits) {
      editedContract.operations = contract.operations.map(operation => {
        const edits = userEdits.operationEdits[operation.id];
        if (edits) {
          return { ...operation, ...edits };
        }
        return operation;
      });
    }

    // Apply layout edits
    if (userEdits.layoutEdits) {
      editedContract.layout = { ...contract.layout, ...userEdits.layoutEdits };
    }

    // Apply style edits
    if (userEdits.styleEdits) {
      editedContract.styling = { ...contract.styling, ...userEdits.styleEdits };
    }

    // Update metadata
    editedContract.metadata = {
      ...contract.metadata,
      updatedAt: new Date()
    };

    return editedContract;
  }

  private generateDefaultQuestions(blueprint: Blueprint): Question[] {
    const questions: Question[] = [];

    // Ask about UI style if not specified
    if (!blueprint.requiredCapabilities.some(cap => cap.includes('ui-style'))) {
      questions.push({
        id: 'ui_style_preference',
        text: 'What style would you prefer for the user interface?',
        type: 'choice',
        options: ['Modern/Minimal', 'Classic/Traditional', 'Colorful/Vibrant', 'Dark Theme', 'Light Theme']
      });
    }

    // Ask about data handling if operations are present but unclear
    if (blueprint.operations.length > 0 && !blueprint.operations.some(op => op.executionType !== 'remote')) {
      questions.push({
        id: 'data_handling_preference',
        text: 'How would you like to handle data in your application?',
        type: 'choice',
        options: ['Use external APIs', 'Work with local files', 'Use built-in data operations', 'Mix of all approaches']
      });
    }

    // Ask about complexity level
    if (blueprint.uiElements.length > 5) {
      questions.push({
        id: 'complexity_preference',
        text: 'This seems like a complex application. Would you prefer to start with a simpler version?',
        type: 'boolean'
      });
    }

    return questions;
  }
}

// Export types and classes
export { LLMClient } from './llm-client';
export type { LLMConfig } from './llm-client';
export { BlueprintGenerator } from './blueprint-generator';
export { EditPreservationSystem } from './edit-preservation';
export type { EditConflict, ConflictResolution } from './edit-preservation';

// Default export
export default AIInterpreterService;