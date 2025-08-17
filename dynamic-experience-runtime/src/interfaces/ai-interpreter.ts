/**
 * AI Interpreter interface - Natural language processing and blueprint generation
 * Requirements: 1.1, 1.2, 1.4, 5.2, 10.4, 10.5
 */

import { Blueprint, Question, Answer, ParsedIntent } from '../types/blueprint';
import { Contract, ContractEdits, ValidationResult } from '../types/contract';

export interface AIInterpreter {
  parseDescription(description: string): Promise<Blueprint>;
  generateQuestions(blueprint: Blueprint): Promise<Question[]>;
  refineBlueprint(blueprint: Blueprint, answers: Answer[]): Promise<Blueprint>;
  generateContract(blueprint: Blueprint, userEdits?: ContractEdits): Promise<Contract>;
  preserveUserEdits(originalContract: Contract, userEdits: ContractEdits): Promise<Contract>;
  regenerateWithPreservation(blueprint: Blueprint, existingContract: Contract, sections: string[]): Promise<Contract>;
}

export interface NaturalLanguageParser {
  extractIntent(description: string): ParsedIntent;
  identifyAmbiguities(intent: ParsedIntent): Question[];
  validateDescription(description: string): ValidationResult;
}

export interface BlueprintGenerator {
  generateFromIntent(intent: ParsedIntent): Blueprint;
  refineWithAnswers(blueprint: Blueprint, answers: Answer[]): Blueprint;
  validateBlueprint(blueprint: Blueprint): ValidationResult;
}

export interface ContractGenerator {
  generateFromBlueprint(blueprint: Blueprint): Promise<Contract>;
  applyUserEdits(contract: Contract, edits: ContractEdits): Contract;
  validateContract(contract: Contract): ValidationResult;
}