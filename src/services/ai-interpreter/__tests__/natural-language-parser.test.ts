/**
 * Natural Language Parser Tests
 * Requirements: 1.1, 1.2, 1.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NaturalLanguageParser } from '../natural-language-parser';
import { LLMClient } from '../llm-client';

// Mock LLM Client
const mockLLMClient = {
  sendMessage: vi.fn()
} as unknown as LLMClient;

describe('NaturalLanguageParser', () => {
  let parser: NaturalLanguageParser;

  beforeEach(() => {
    parser = new NaturalLanguageParser(mockLLMClient);
    vi.clearAllMocks();
  });

  describe('validateDescription', () => {
    it('should reject empty descriptions', () => {
      const result = parser.validateDescription('');
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('EMPTY_DESCRIPTION');
    });

    it('should warn about short descriptions', () => {
      const result = parser.validateDescription('short');
      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.code === 'SHORT_DESCRIPTION')).toBe(true);
    });

    it('should warn about very long descriptions', () => {
      const longDescription = 'a'.repeat(5001);
      const result = parser.validateDescription(longDescription);
      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.code === 'LONG_DESCRIPTION')).toBe(true);
    });

    it('should warn when missing action words', () => {
      const result = parser.validateDescription('This is a simple description without action words');
      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.code === 'MISSING_ACTION_WORDS')).toBe(true);
    });

    it('should pass validation for good descriptions', () => {
      const result = parser.validateDescription('Create a todo list application with add, edit, and delete functionality');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('extractIntent', () => {
    it('should extract intent from natural language description', async () => {
      const mockResponse = {
        content: JSON.stringify({
          goal: 'Create a todo list application',
          requiredCapabilities: ['task-management', 'data-persistence'],
          uiElements: [
            {
              type: 'input',
              purpose: 'Add new tasks',
              capabilities: ['text-input']
            },
            {
              type: 'list',
              purpose: 'Display tasks',
              capabilities: ['data-display']
            }
          ],
          operations: [
            {
              name: 'addTask',
              purpose: 'Add a new task',
              inputs: ['taskText'],
              outputs: ['taskId'],
              executionType: 'local'
            }
          ],
          ambiguities: []
        })
      };

      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue(mockResponse);

      const result = await parser.extractIntent('Create a todo list application');

      expect(result.goal).toBe('Create a todo list application');
      expect(result.requiredCapabilities).toContain('task-management');
      expect(result.uiElements).toHaveLength(2);
      expect(result.operations).toHaveLength(1);
      expect(result.ambiguities).toHaveLength(0);
    });

    it('should handle LLM response with extra text', async () => {
      const mockResponse = {
        content: `Here's the analysis:
        
        {
          "goal": "Create a simple calculator",
          "requiredCapabilities": ["arithmetic"],
          "uiElements": [],
          "operations": [],
          "ambiguities": []
        }
        
        This should work well for your needs.`
      };

      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue(mockResponse);

      const result = await parser.extractIntent('Create a simple calculator');

      expect(result.goal).toBe('Create a simple calculator');
      expect(result.requiredCapabilities).toContain('arithmetic');
    });

    it('should handle malformed JSON responses', async () => {
      const mockResponse = {
        content: 'This is not valid JSON'
      };

      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue(mockResponse);

      await expect(parser.extractIntent('Create an app')).rejects.toThrow('No JSON found in LLM response');
    });

    it('should normalize incomplete responses', async () => {
      const mockResponse = {
        content: JSON.stringify({
          goal: 'Create an app',
          // Missing other required fields
        })
      };

      vi.mocked(mockLLMClient.sendMessage).mockResolvedValue(mockResponse);

      const result = await parser.extractIntent('Create an app');

      expect(result.goal).toBe('Create an app');
      expect(result.requiredCapabilities).toEqual([]);
      expect(result.uiElements).toEqual([]);
      expect(result.operations).toEqual([]);
      expect(result.ambiguities).toEqual([]);
    });
  });

  describe('identifyAmbiguities', () => {
    it('should convert ambiguities to questions', () => {
      const intent = {
        goal: 'Create an app',
        requiredCapabilities: [],
        uiElements: [],
        operations: [],
        ambiguities: [
          {
            id: 'ui_style',
            description: 'UI style preference unclear',
            options: ['modern', 'classic'],
            question: 'What UI style do you prefer?'
          },
          {
            id: 'data_source',
            description: 'Data source not specified',
            options: [],
            question: 'Where will the data come from?'
          }
        ]
      };

      const questions = parser.identifyAmbiguities(intent);

      expect(questions).toHaveLength(2);
      expect(questions[0].type).toBe('choice');
      expect(questions[0].options).toEqual(['modern', 'classic']);
      expect(questions[1].type).toBe('text');
      expect(questions[1].options).toBeUndefined();
    });
  });
});