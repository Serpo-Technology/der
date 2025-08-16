/**
 * AI Interpreter Service - Main orchestrator for blueprint generation
 * Requirements: 1.1, 1.2, 1.4, 5.2, 10.4, 10.5
 */

import { AIInterpreter } from '../../interfaces/ai-interpreter';
import { Blueprint, Question, Answer } from '../../types/blueprint';
import { Contract, ContractEdits } from '../../types/contract';
import { ComponentRepository } from '../../types/repository';
import { LLMClient, LLMConfig } from './llm-client';
import { NaturalLanguageParser } from './natural-language-parser';
import { BlueprintGenerator } from './blueprint-generator';
import { ContractBuilder } from './contract-builder';
import { EditPreservationSystem, EditConflict, ConflictResolution } from './edit-preservation';

export class AIInterpreterService implements AIInterpreter {
  private llmClient: LLMClient;
  private parser: NaturalLanguageParser;
  private generator: BlueprintGenerator;
  private repository: ComponentRepository;
  private editPreservation: EditPreservationSystem;

  constructor(llmConfig: LLMConfig, repository: ComponentRepository) {
    this.llmClient = new LLMClient(llmConfig);
    this.parser = new NaturalLanguageParser(this.llmClient);
    this.generator = new BlueprintGenerator();
    this.repository = repository;
    this.editPreservation = new EditPreservationSystem();
  }

  async parseDescription(description: string): Promise<Blueprint> {
    // Validate the input description
    const validationResult = this.parser.validateDescription(description);
    if (!validationResult.isValid) {
      throw new Error(`Invalid description: ${validationResult.errors.map(e => e.message).join(', ')}`);
    }

    try {
      // Extract intent from natural language
      const intent = await this.parser.extractIntent(description);
      
      // Generate blueprint from intent
      const blueprint = this.generator.generateFromIntent(intent);
      
      // Validate the generated blueprint
      const blueprintValidation = this.generator.validateBlueprint(blueprint);
      if (!blueprintValidation.isValid) {
        throw new Error(`Generated blueprint is invalid: ${blueprintValidation.errors.map(e => e.message).join(', ')}`);
      }

      return blueprint;
    } catch (error) {
      throw new Error(`Failed to parse description: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async generateQuestions(blueprint: Blueprint): Promise<Question[]> {
    // Extract questions from ambiguities in the blueprint
    const questions = this.parser.identifyAmbiguities(blueprint);
    
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

  async generateContract(blueprint: Blueprint, userEdits?: ContractEdits): Promise<Contract> {
    try {
      // Create contract builder with repository access
      const contractBuilder = new ContractBuilder(this.repository);
      
      // Generate contract from blueprint
      let contract = await contractBuilder.generateFromBlueprint(blueprint);
      
      // Apply user edits if provided
      if (userEdits) {
        contract = this.applyUserEditsToContract(contract, userEdits);
      }
      
      return contract;
    } catch (error) {
      throw new Error(`Failed to generate contract: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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
      const contractBuilder = new ContractBuilder(this.repository);
      const newContract = await contractBuilder.generateFromBlueprint(blueprint);
      
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
      const contractBuilder = new ContractBuilder(this.repository);
      const newContract = await contractBuilder.generateFromBlueprint(blueprint);
      
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
export { NaturalLanguageParser } from './natural-language-parser';
export { BlueprintGenerator } from './blueprint-generator';
export { ContractBuilder } from './contract-builder';
export { EditPreservationSystem } from './edit-preservation';
export type { EditConflict, ConflictResolution } from './edit-preservation';

// Default export
export default AIInterpreterService;