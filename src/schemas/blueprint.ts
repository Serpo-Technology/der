/**
 * Blueprint schemas - validate LLM-produced intent/blueprint JSON.
 */

import { z } from 'zod';

export const UIElementRequirementSchema = z.object({
  type: z.string().min(1),
  purpose: z.string().default(''),
  properties: z.record(z.string(), z.any()).optional(),
  capabilities: z.array(z.string()).default([]),
});

export const OperationRequirementSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().default(''),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  executionType: z.enum(['builtin', 'remote', 'local', 'repository']).default('builtin'),
});

export const AmbiguitySchema = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  options: z.array(z.string()).default([]),
  question: z.string().default(''),
});

export const ParsedIntentSchema = z.object({
  goal: z.string().min(1),
  requiredCapabilities: z.array(z.string()).default([]),
  uiElements: z.array(UIElementRequirementSchema).default([]),
  operations: z.array(OperationRequirementSchema).default([]),
  ambiguities: z.array(AmbiguitySchema).default([]),
});

export const BlueprintSchema = ParsedIntentSchema.extend({
  description: z.string().default(''),
  userModifications: z.array(z.any()).optional(),
});

export type ParsedIntentShape = z.output<typeof ParsedIntentSchema>;
export type BlueprintShape = z.output<typeof BlueprintSchema>;
