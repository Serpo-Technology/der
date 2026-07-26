/**
 * Contract schemas: the structural shapes (zod) contracts and model
 * responses parse against, plus their inferred types. Semantic validation
 * (the manifest checker) lives in the runtime kernel; hosts reach it
 * through runtime_check_contract or the kernel's validate operation.
 */


import { z } from 'zod';
import type { ValidationWarning } from '../types/contract';

export const TransformFunctionSchema = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.any()).default({}),
});

const TransformPipelineSchema = z.array(TransformFunctionSchema);


export const DataBindingSchema = z.object({
  property: z.string().min(1),
  source: z.enum(['operation', 'state', 'constant', 'item']),
  sourceId: z.string(),
  value: z.unknown().optional(),
  transform: TransformFunctionSchema.optional(),
  transforms: TransformPipelineSchema.optional(),
});

export const EventBindingSchema = z.object({
  event: z.string().min(1),
  operationId: z.string().min(1),
  parameters: z.record(z.string(), z.any()).optional(),
});

export const VisibilityConditionSchema = z.object({
  source: z.enum(['state', 'item']),
  sourceId: z.string().min(1),
  operator: z.enum([
    'truthy',
    'falsy',
    'empty',
    'notEmpty',
    'equals',
    'notEquals',
    'gt',
    'gte',
    'lt',
    'lte',
  ]),
  value: z.unknown().optional(),
  transforms: TransformPipelineSchema.optional(),
});

export const UIElementSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  properties: z.record(z.string(), z.any()).default({}),
  dataBindings: z.array(DataBindingSchema).default([]),
  eventBindings: z.array(EventBindingSchema).default([]),
  visibleWhen: z
    .union([VisibilityConditionSchema, z.array(VisibilityConditionSchema)])
    .optional(),
  get children() {
    return z.array(UIElementSchema).optional();
  },
});

export const InputBindingSchema = z.object({
  name: z.string().min(1),
  source: z.enum(['ui-element', 'state', 'constant', 'item']),
  sourceId: z.string(),
  value: z.unknown().optional(),
  transform: TransformFunctionSchema.optional(),
  transforms: TransformPipelineSchema.optional(),
});

export const OutputBindingSchema = z.object({
  name: z.string().min(1),
  target: z.enum(['ui-element', 'state']),
  targetId: z.string().min(1),
  property: z.string().optional(),
  transform: TransformFunctionSchema.optional(),
  transforms: TransformPipelineSchema.optional(),
});

const ExecutionTypeSchema = z.enum(['builtin', 'local', 'remote', 'repository']);

export const OperationBindingSchema = z.object({
  id: z.string().min(1),
  operationName: z.string().min(1),
  inputs: z.array(InputBindingSchema).default([]),
  outputs: z.array(OutputBindingSchema).default([]),
  triggers: z.array(z.any()).default([]),
  executionType: ExecutionTypeSchema.optional(),
  implementation: z
    .object({
      type: ExecutionTypeSchema,
      endpoint: z.string().optional(),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      code: z.string().optional(),
      repositoryId: z.string().optional(),
      auth: z.string().optional(),
    })
    .optional(),
});

export const LayoutSpecSchema = z.object({
  type: z.enum(['grid', 'flex', 'absolute']).default('flex'),
  properties: z.record(z.string(), z.any()).default({}),
});

export const StyleSpecSchema = z.object({
  theme: z.string().default('default'),
  accent: z.string().optional(),
  background: z.string().optional(),
  customStyles: z.record(z.string(), z.any()).optional(),
});

export const ContractMetadataSchema = z.object({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  version: z.string().default('1.0.0'),
  author: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const ContractSchema = z.object({
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  initialState: z.record(z.string(), z.any()).optional(),
  elements: z.array(UIElementSchema).min(1),
  operations: z.array(OperationBindingSchema).default([]),
  layout: LayoutSpecSchema.default({ type: 'flex', properties: {} }),
  styling: StyleSpecSchema.default({ theme: 'default' }),
  metadata: ContractMetadataSchema.optional(),
});

/**
 * The model's vocabulary: builtin and remote only, and the implementation is a
 * strict remote shape, so an emitted `code` key is a PARSE ERROR the repair
 * round explains instead of a silently stripped field.
 */
const LlmOperationBindingSchema = OperationBindingSchema.extend({
  executionType: z.enum(['builtin', 'remote']).optional(),
  implementation: z
    .strictObject({
      type: z.enum(['remote']),
      endpoint: z.string(),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      auth: z.string().optional(),
    })
    .optional(),
});

export const LlmContractSchema = ContractSchema.extend({
  operations: z.array(LlmOperationBindingSchema).default([]),
});

/**
 * The single-call creation response: a small spec header carrying the model's
 * reading of the request (shown in the Blueprint tab and surfaced as
 * informational warnings), plus either the composed contract or the name of
 * an installed recipe that already is the requested app.
 */
export const ComposedSpecSchema = z.object({
  goal: z.string().default(''),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export const ComposedResponseSchema = z
  .object({
    spec: ComposedSpecSchema.default({ goal: '', assumptions: [], openQuestions: [] }),
    contract: LlmContractSchema.optional(),
    recipe: z.string().min(1).optional(),
  })
  .refine((value) => (value.contract === undefined) !== (value.recipe === undefined), {
    message:
      'Respond with exactly one of "contract" (a composed app) or "recipe" (an installed app name)',
  });

export type ComposedSpecShape = z.output<typeof ComposedSpecSchema>;
export type ComposedResponseShape = z.output<typeof ComposedResponseSchema>;

export type ContractShape = z.output<typeof ContractSchema>;

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Semantic validation against the part manifests
// ---------------------------------------------------------------------------

export interface ManifestError {
  path: string;
  message: string;
  code: string;
}

export interface ManifestCheckResult {
  /** Repairable problems: fed back to the model, or errors on load. */
  errors: ManifestError[];
  /** Degradations applied in place. */
  warnings: ValidationWarning[];
}

/** Formats manifest errors for the model-facing repair round. */
export function formatManifestErrors(errors: ManifestError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('\n');
}
