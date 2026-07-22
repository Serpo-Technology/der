/**
 * AI Interpreter interface - single-call composition and blueprint projection
 */

import { Blueprint, ComposedSpec, Question, Answer } from '../types/blueprint';
import { Contract, ContractEdits, ValidationResult, ValidationWarning } from '../types/contract';

export interface AIInterpreter {
  compose(description: string): Promise<{
    blueprint: Blueprint;
    contract: Contract;
    spec: ComposedSpec;
    warnings: ValidationWarning[];
  }>;
  generateQuestions(blueprint: Blueprint): Promise<Question[]>;
  refineBlueprint(blueprint: Blueprint, answers: Answer[]): Promise<Blueprint>;
  generateContract(blueprint: Blueprint, userEdits?: ContractEdits): Promise<Contract>;
  preserveUserEdits(originalContract: Contract, userEdits: ContractEdits): Promise<Contract>;
  regenerateWithPreservation(blueprint: Blueprint, existingContract: Contract, sections: string[]): Promise<Contract>;
}

export interface BlueprintGenerator {
  deriveFromComposition(spec: ComposedSpec, contract: Contract, description: string): Blueprint;
  refineWithAnswers(blueprint: Blueprint, answers: Answer[]): Blueprint;
  validateBlueprint(blueprint: Blueprint): ValidationResult;
}

export interface ContractGenerator {
  generateFromBlueprint(blueprint: Blueprint): Promise<Contract>;
  applyUserEdits(contract: Contract, edits: ContractEdits): Contract;
  validateContract(contract: Contract): ValidationResult;
}
