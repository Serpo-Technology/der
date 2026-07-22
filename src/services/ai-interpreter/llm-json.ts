/**
 * Structured-JSON generation helper: send messages, extract and validate the
 * JSON response, and run one repair round feeding validation problems back
 * before failing.
 */

import { z } from 'zod';
import { LLMClient, LLMMessage } from './llm-client';
import { formatZodError } from '../../schemas/contract';

/**
 * Pulls the first balanced JSON object out of a model response, tolerating
 * code fences and surrounding prose.
 */
export function extractJson(text: string): string {
  let source = text.trim();
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    source = fence[1].trim();
  }
  const start = source.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in the response');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error('Unbalanced JSON object in the response');
}

export interface GenerateJsonOptions<T = unknown> {
  /** Used in error messages, e.g. "Blueprint" or "Contract". */
  label: string;
  maxTokens?: number;
  /**
   * Post-parse semantic validation; returned problem strings count as a
   * validation failure and feed the repair round. May mutate the parsed value
   * to apply degradations; mutations only survive when no problems remain.
   */
  semanticCheck?: (value: T) => string[];
}

export async function generateValidatedJson<S extends z.ZodType>(
  llm: LLMClient,
  messages: LLMMessage[],
  schema: S,
  options: GenerateJsonOptions<z.output<S>>
): Promise<z.output<S>> {
  const attempt = async (conversation: LLMMessage[]) => {
    const response = await llm.sendMessage(conversation, {
      jsonMode: true,
      maxTokens: options.maxTokens,
    });
    return response.content;
  };

  const parse = (raw: string): { ok: true; value: z.output<S> } | { ok: false; problem: string } => {
    let candidate: unknown;
    try {
      candidate = JSON.parse(extractJson(raw));
    } catch (error) {
      return {
        ok: false,
        problem: `The response was not parseable JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const result = schema.safeParse(candidate);
    if (!result.success) {
      return { ok: false, problem: `The JSON failed validation:\n${formatZodError(result.error)}` };
    }
    if (options.semanticCheck) {
      const problems = options.semanticCheck(result.data);
      if (problems.length > 0) {
        return { ok: false, problem: `The JSON violates part manifests:\n${problems.join('\n')}` };
      }
    }
    return { ok: true, value: result.data };
  };

  const first = await attempt(messages);
  const firstParse = parse(first);
  if (firstParse.ok) {
    return firstParse.value;
  }

  const repairMessages: LLMMessage[] = [
    ...messages,
    { role: 'assistant', content: first },
    {
      role: 'user',
      content: `Your previous response had problems:\n${firstParse.problem}\n\nReturn the corrected JSON object only. No prose, no code fences.`,
    },
  ];
  const second = await attempt(repairMessages);
  const secondParse = parse(second);
  if (secondParse.ok) {
    return secondParse.value;
  }

  throw new Error(`${options.label} generation failed after a repair attempt. ${secondParse.problem}`);
}
