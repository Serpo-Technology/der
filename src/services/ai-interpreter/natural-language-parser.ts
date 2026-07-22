/**
 * Natural Language Parser - Extracts intent and capabilities from user descriptions
 * Requirements: 1.1, 1.2, 1.4
 */

import { ParsedIntent, Question } from '../../types/blueprint';
import { ValidationResult, ValidationError, ValidationWarning } from '../../types/contract';
import { LLMClient, LLMMessage } from './llm-client';
import { ParsedIntentSchema } from '../../schemas/blueprint';
import { generateValidatedJson } from './llm-json';
import { BUILTIN_OPERATIONS, ELEMENT_MANIFESTS } from '../operations/registry';

export class NaturalLanguageParser {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  async extractIntent(description: string): Promise<ParsedIntent> {
    const messages: LLMMessage[] = [
      { role: 'system', content: this.getIntentExtractionPrompt() },
      {
        role: 'user',
        content: `Analyze this description and return the structured intent JSON:\n\n"${description}"`,
      },
    ];

    try {
      return await generateValidatedJson(this.llmClient, messages, ParsedIntentSchema, {
        label: 'Blueprint',
        maxTokens: 4096,
      });
    } catch (error) {
      throw new Error(
        `Failed to extract intent: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  identifyAmbiguities(intent: ParsedIntent): Question[] {
    return intent.ambiguities.map(ambiguity => ({
      id: ambiguity.id,
      text: ambiguity.question,
      type: ambiguity.options.length > 0 ? 'choice' : 'text',
      options: ambiguity.options.length > 0 ? ambiguity.options : undefined
    }));
  }

  validateDescription(description: string): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Basic validation
    if (!description || description.trim().length === 0) {
      errors.push({
        path: 'description',
        message: 'Description cannot be empty',
        code: 'EMPTY_DESCRIPTION'
      });
    }

    if (description.length < 10) {
      warnings.push({
        path: 'description',
        message: 'Description is very short, consider providing more details',
        code: 'SHORT_DESCRIPTION'
      });
    }

    if (description.length > 5000) {
      warnings.push({
        path: 'description',
        message: 'Description is very long, consider breaking it into smaller parts',
        code: 'LONG_DESCRIPTION'
      });
    }

    // Check for common patterns that might indicate missing information
    const hasActionWords = /\b(create|build|make|show|display|manage|handle|process)\b/i.test(description);
    if (!hasActionWords) {
      warnings.push({
        path: 'description',
        message: 'Consider including action words to clarify what you want to accomplish',
        code: 'MISSING_ACTION_WORDS'
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  private getIntentExtractionPrompt(): string {
    const operationNames = Object.values(BUILTIN_OPERATIONS)
      .filter((def) => !def.hidden)
      .map((def) => def.name)
      .join(', ');
    const elementTypes = Object.keys(ELEMENT_MANIFESTS).join(', ');
    return `You analyze a user's description of a small desktop app and extract structured intent.

Return one JSON object only (no prose, no code fences) with exactly this shape:
{
  "goal": "one sentence stating what the user wants",
  "requiredCapabilities": ["specific capability tags like data-entry, list-display, http-fetch"],
  "uiElements": [
    { "type": "element type", "purpose": "what it is for", "capabilities": ["tags"] }
  ],
  "operations": [
    { "name": "operation name", "purpose": "what it does", "inputs": ["parameter names"], "outputs": ["output names"], "executionType": "builtin" }
  ],
  "ambiguities": [
    { "id": "unique_id", "description": "what is unclear", "options": ["interpretation A", "interpretation B"], "question": "clarifying question" }
  ]
}

Guidelines:
- Preferred element types (rendered natively): ${elementTypes}. Plain HTML tag names are also accepted.
- Built-in operations exist for common behavior: ${operationNames}. When one fits, use its exact name and executionType "builtin".
- Other executionType values: "remote" for calling an external HTTP API, "local" for custom in-app computation.
- Only list ambiguities that genuinely change what should be built; do not invent questions for clear requests.
- Keep the design minimal: the fewest elements and operations that satisfy the request.`;
  }
}
