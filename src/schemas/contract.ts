/**
 * Contract schemas - the single validation authority for contracts, used both
 * to validate LLM output (with a repair round) and loaded contracts.
 */

import { z } from 'zod';
import type { Contract, EventBinding, UIElement, ValidationResult } from '../types/contract';

export const TransformFunctionSchema = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.any()).default({}),
});

export const DataBindingSchema = z.object({
  property: z.string().min(1),
  source: z.enum(['operation', 'state', 'constant', 'item']),
  sourceId: z.string(),
  transform: TransformFunctionSchema.optional(),
});

export const EventBindingSchema = z.object({
  event: z.string().min(1),
  operationId: z.string().min(1),
  parameters: z.record(z.string(), z.any()).optional(),
});

export const UIElementSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  properties: z.record(z.string(), z.any()).default({}),
  dataBindings: z.array(DataBindingSchema).default([]),
  eventBindings: z.array(EventBindingSchema).default([]),
  get children() {
    return z.array(UIElementSchema).optional();
  },
});

export const InputBindingSchema = z.object({
  name: z.string().min(1),
  source: z.enum(['ui-element', 'state', 'constant', 'item']),
  sourceId: z.string(),
  transform: TransformFunctionSchema.optional(),
});

export const OutputBindingSchema = z.object({
  name: z.string().min(1),
  target: z.enum(['ui-element', 'state']),
  targetId: z.string().min(1),
  property: z.string().optional(),
  transform: TransformFunctionSchema.optional(),
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
    })
    .optional(),
});

export const LayoutSpecSchema = z.object({
  type: z.enum(['grid', 'flex', 'absolute']).default('flex'),
  properties: z.record(z.string(), z.any()).default({}),
});

export const StyleSpecSchema = z.object({
  theme: z.string().default('default'),
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

export type ContractShape = z.output<typeof ContractSchema>;

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/** Validates a contract-shaped object and reports issues in the app's ValidationResult shape. */
export function validateContractObject(data: unknown): ValidationResult {
  const parsed = ContractSchema.safeParse(data);
  if (!parsed.success) {
    return {
      isValid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
        code: issue.code.toUpperCase(),
      })),
      warnings: [],
    };
  }

  // Referential check: every event binding must point at a declared operation.
  const operationIds = new Set(parsed.data.operations.map((op) => op.id));
  const errors: ValidationResult['errors'] = [];
  const visit = (element: z.output<typeof UIElementSchema>, path: string) => {
    element.eventBindings.forEach((binding, index) => {
      if (!operationIds.has(binding.operationId)) {
        errors.push({
          path: `${path}.eventBindings.${index}`,
          message: `Event binding references unknown operation "${binding.operationId}"`,
          code: 'UNKNOWN_OPERATION',
        });
      }
    });
    element.children?.forEach((child, index) => visit(child, `${path}.children.${index}`));
  };
  parsed.data.elements.forEach((element, index) => visit(element, `elements.${index}`));

  return { isValid: errors.length === 0, errors, warnings: [] };
}

interface LegacyTrigger {
  type?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Converts legacy trigger wiring into event bindings (deduped against ones
 * that already exist) and drops trigger kinds the runtime does not run.
 * Pure: returns a new contract object.
 */
export function normalizeContract(contract: Contract): Contract {
  const pendingByElement = new Map<string, EventBinding[]>();

  const operations = contract.operations.map((operation) => {
    const triggers = (operation.triggers ?? []) as LegacyTrigger[];
    for (const trigger of triggers) {
      if (trigger?.type === 'event' && trigger.parameters?.elementId) {
        const elementId = String(trigger.parameters.elementId);
        const event = String(trigger.parameters.eventType ?? 'click');
        const list = pendingByElement.get(elementId) ?? [];
        list.push({ event, operationId: operation.id });
        pendingByElement.set(elementId, list);
      } else if (trigger?.type) {
        console.warn(
          `Dropping unsupported trigger type "${trigger.type}" on operation ${operation.id}`
        );
      }
    }
    return { ...operation, triggers: [] };
  });

  const mergeElement = (element: UIElement): UIElement => {
    const pending = pendingByElement.get(element.id) ?? [];
    const existing = element.eventBindings ?? [];
    const merged = [...existing];
    for (const binding of pending) {
      const duplicate = existing.some(
        (b) => b.event === binding.event && b.operationId === binding.operationId
      );
      if (!duplicate) merged.push(binding);
    }
    return {
      ...element,
      eventBindings: merged,
      children: element.children?.map(mergeElement),
    };
  };

  return { ...contract, operations, elements: contract.elements.map(mergeElement) };
}
