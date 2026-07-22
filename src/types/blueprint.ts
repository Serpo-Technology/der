/**
 * Blueprint types - Natural language input processing
 * Requirements: 1.1, 1.2, 1.4
 */

export interface Blueprint {
  description: string;
  goal: string;
  requiredCapabilities: string[];
  uiElements: UIElementRequirement[];
  operations: OperationRequirement[];
  ambiguities: Ambiguity[];
  userModifications?: UserModification[];
}

export interface UIElementRequirement {
  type: string;
  purpose: string;
  properties?: Record<string, any>;
  capabilities: string[];
}

export interface OperationRequirement {
  name: string;
  purpose: string;
  inputs: string[];
  outputs: string[];
  executionType: 'builtin' | 'remote' | 'local' | 'repository';
}

export interface Ambiguity {
  id: string;
  description: string;
  options: string[];
  question: string;
}

export interface UserModification {
  location: string;
  originalValue: any;
  newValue: any;
  timestamp: Date;
  preserved: boolean;
}

/**
 * The model's reading of a creation request, returned alongside the contract
 * by the single composed call and projected into the Blueprint tab.
 */
export interface ComposedSpec {
  goal: string;
  assumptions: string[];
  openQuestions: string[];
}

export interface ParsedIntent {
  goal: string;
  requiredCapabilities: string[];
  uiElements: UIElementRequirement[];
  operations: OperationRequirement[];
  ambiguities: Ambiguity[];
}

export interface Question {
  id: string;
  text: string;
  type: 'choice' | 'text' | 'boolean';
  options?: string[];
}

export interface Answer {
  questionId: string;
  value: string | boolean;
}