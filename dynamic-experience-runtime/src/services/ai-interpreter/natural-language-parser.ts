/**
 * Natural Language Parser - Extracts intent and capabilities from user descriptions
 * Requirements: 1.1, 1.2, 1.4
 */

import { ParsedIntent, UIElementRequirement, OperationRequirement, Ambiguity, Question } from '../../types/blueprint';
import { ValidationResult, ValidationError, ValidationWarning } from '../../interfaces/ai-interpreter';
import { LLMClient, LLMMessage } from './llm-client';

export class NaturalLanguageParser {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  async extractIntent(description: string): Promise<ParsedIntent> {
    const systemPrompt = this.getIntentExtractionPrompt();
    const userPrompt = `Please analyze this user description and extract the structured intent:

"${description}"

Return a JSON object with the following structure:
{
  "goal": "clear statement of what the user wants to achieve",
  "requiredCapabilities": ["list", "of", "required", "capabilities"],
  "uiElements": [
    {
      "type": "element type (e.g., button, input, list, chart)",
      "purpose": "what this element is for",
      "capabilities": ["required", "capabilities"]
    }
  ],
  "operations": [
    {
      "name": "operation name",
      "purpose": "what this operation does",
      "inputs": ["input", "parameters"],
      "outputs": ["output", "data"],
      "executionType": "remote|local|repository"
    }
  ],
  "ambiguities": [
    {
      "id": "unique_id",
      "description": "what is ambiguous",
      "options": ["possible", "interpretations"],
      "question": "clarifying question to ask user"
    }
  ]
}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    try {
      const response = await this.llmClient.sendMessage(messages);
      const parsedIntent = this.parseIntentResponse(response.content);
      return parsedIntent;
    } catch (error) {
      throw new Error(`Failed to extract intent: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    return `You are an expert system that analyzes user descriptions of desired applications and extracts structured intent.

Your task is to:
1. Identify the main goal the user wants to achieve
2. Determine what UI elements would be needed
3. Identify what operations/functionality would be required
4. Detect any ambiguities that need clarification

Guidelines:
- UI element types should be common web/desktop elements: button, input, textarea, select, checkbox, radio, list, table, chart, image, video, etc.
- Operation execution types:
  - "remote": API calls, web services, external data sources
  - "local": file system operations, device capabilities, local computations
  - "repository": operations provided by the component repository
- Identify ambiguities when the user's intent could be interpreted multiple ways
- Required capabilities should be specific and actionable (e.g., "data-visualization", "file-upload", "user-authentication")

Always return valid JSON that matches the specified structure exactly.`;
  }

  private parseIntentResponse(response: string): ParsedIntent {
    try {
      // Extract JSON from response (handle cases where LLM adds extra text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      // Validate and normalize the parsed response
      return {
        goal: parsed.goal || '',
        requiredCapabilities: Array.isArray(parsed.requiredCapabilities) ? parsed.requiredCapabilities : [],
        uiElements: this.normalizeUIElements(parsed.uiElements || []),
        operations: this.normalizeOperations(parsed.operations || []),
        ambiguities: this.normalizeAmbiguities(parsed.ambiguities || [])
      };
    } catch (error) {
      throw new Error(`Failed to parse LLM response: ${error instanceof Error ? error.message : 'Invalid JSON'}`);
    }
  }

  private normalizeUIElements(elements: any[]): UIElementRequirement[] {
    return elements.map((element, _index) => ({
      type: element.type || 'unknown',
      purpose: element.purpose || '',
      properties: element.properties || {},
      capabilities: Array.isArray(element.capabilities) ? element.capabilities : []
    }));
  }

  private normalizeOperations(operations: any[]): OperationRequirement[] {
    return operations.map((operation, index) => ({
      name: operation.name || `operation_${index}`,
      purpose: operation.purpose || '',
      inputs: Array.isArray(operation.inputs) ? operation.inputs : [],
      outputs: Array.isArray(operation.outputs) ? operation.outputs : [],
      executionType: ['remote', 'local', 'repository'].includes(operation.executionType) 
        ? operation.executionType 
        : 'remote'
    }));
  }

  private normalizeAmbiguities(ambiguities: any[]): Ambiguity[] {
    return ambiguities.map((ambiguity, index) => ({
      id: ambiguity.id || `ambiguity_${index}`,
      description: ambiguity.description || '',
      options: Array.isArray(ambiguity.options) ? ambiguity.options : [],
      question: ambiguity.question || ''
    }));
  }
}