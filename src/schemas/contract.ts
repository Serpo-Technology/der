/**
 * Contract schemas - the single validation authority for contracts. Structural
 * validation via zod (LLM output gets a stricter schema that forbids code so
 * the repair round teaches the model), semantic validation against the part
 * manifests via checkAgainstManifests.
 */

import { z } from 'zod';
import type {
  Contract,
  EventBinding,
  InputBinding,
  OperationBinding,
  UIElement,
  ValidationResult,
  ValidationWarning,
} from '../types/contract';
import { ELEMENT_MANIFESTS, getOperationDef } from '../services/operations/registry';
import { TRANSFORMS } from '../services/operations/transforms';

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
    })
    .optional(),
});

export const LlmContractSchema = ContractSchema.extend({
  operations: z.array(LlmOperationBindingSchema).default([]),
});

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

function warn(warnings: ValidationWarning[], path: string, message: string): void {
  warnings.push({ path, message, code: 'MANIFEST_ADJUSTED' });
}

function walkElements(
  elements: UIElement[],
  visit: (element: UIElement, path: string, inListTemplate: boolean) => void,
  path = 'elements',
  inListTemplate = false
): void {
  elements.forEach((element, index) => {
    const here = `${path}.${index}`;
    visit(element, here, inListTemplate);
    if (element.children?.length) {
      const childTemplate =
        inListTemplate || (element.type === 'list' && element.children.length > 0);
      walkElements(element.children, visit, `${here}.children`, childTemplate);
    }
  });
}

function checkPipeline(
  owner: string,
  binding: { transform?: { type: string }; transforms?: { type: string }[] },
  warnings: ValidationWarning[]
): void {
  if (binding.transforms) {
    const known = binding.transforms.filter((step) => {
      if (TRANSFORMS[step.type]) return true;
      warn(warnings, owner, `Unknown transform "${step.type}" removed`);
      return false;
    });
    binding.transforms = known;
  }
  if (binding.transform && !TRANSFORMS[binding.transform.type]) {
    warn(warnings, owner, `Unknown transform "${binding.transform.type}" removed`);
    delete binding.transform;
  }
}

/**
 * Validates and normalizes a structurally valid contract against the part
 * manifests. Mutates the given contract for degradations (dropped unknown
 * inputs, defaulted knobs, seeded state keys); returns repairable errors and
 * the applied-degradation warnings.
 */
export function checkAgainstManifests(contract: ContractShape): ManifestCheckResult {
  const errors: ManifestError[] = [];
  const warnings: ValidationWarning[] = [];
  const fail = (path: string, message: string, code: string) =>
    errors.push({ path, message, code });

  // Collect element ids, state reads, and state writes.
  const elementIds = new Set<string>();
  const stateReads = new Map<string, string>(); // key -> first reading property
  const stateWrites = new Set<string>(Object.keys(contract.initialState ?? {}));
  const operationIds = new Set(contract.operations.map((op) => op.id));

  walkElements(contract.elements as UIElement[], (element, path, inListTemplate) => {
    elementIds.add(element.id);

    // Knob normalization against the element manifest.
    const manifest = ELEMENT_MANIFESTS[element.type];
    if (manifest) {
      for (const knob of manifest.knobs) {
        const value = element.properties?.[knob.name];
        if (
          knob.type === 'enum' &&
          value !== undefined &&
          !(knob.values ?? []).includes(String(value))
        ) {
          warn(
            warnings,
            `${path}.properties.${knob.name}`,
            `"${value}" is not one of ${(knob.values ?? []).join('|')}; using "${knob.default}"`
          );
          if (knob.default !== undefined) {
            element.properties[knob.name] = knob.default;
          } else {
            delete element.properties[knob.name];
          }
        }
      }
    }

    element.dataBindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${path}.dataBindings.${bindingIndex}`;
      checkPipeline(bindingPath, binding, warnings);
      if (binding.source === 'state' && binding.sourceId) {
        const existing = stateReads.get(binding.sourceId);
        // Array-shaped readers win so the seed becomes [] regardless of order.
        const isArrayReader = binding.property === 'items' || binding.property === 'options';
        if (existing === undefined || (isArrayReader && existing !== 'items' && existing !== 'options')) {
          stateReads.set(binding.sourceId, binding.property);
        }
      }
      if (binding.source === 'item' && !inListTemplate) {
        warn(warnings, bindingPath, `"item" binding outside a list template resolves to nothing`);
      }
    });

    const conditions = Array.isArray(element.visibleWhen)
      ? element.visibleWhen
      : element.visibleWhen
        ? [element.visibleWhen]
        : [];
    conditions.forEach((condition, conditionIndex) => {
      checkPipeline(`${path}.visibleWhen.${conditionIndex}`, condition, warnings);
      if (condition.source === 'state') {
        if (!stateReads.has(condition.sourceId)) {
          stateReads.set(condition.sourceId, 'visibleWhen');
        }
      } else if (!inListTemplate) {
        warn(
          warnings,
          `${path}.visibleWhen.${conditionIndex}`,
          `"item" condition outside a list template resolves to nothing`
        );
      }
    });

    element.eventBindings.forEach((binding: EventBinding, bindingIndex) => {
      if (!operationIds.has(binding.operationId)) {
        fail(
          `${path}.eventBindings.${bindingIndex}`,
          `Event "${binding.event}" references unknown operation "${binding.operationId}"`,
          'UNKNOWN_OPERATION'
        );
      }
    });
  });

  // Operations against manifests.
  contract.operations.forEach((op, opIndex) => {
    const opPath = `operations.${opIndex}`;
    const def = getOperationDef(op.operationName);
    const isBuiltinName = Boolean(def);
    const hasEndpoint = Boolean(op.implementation?.endpoint);
    const hasCode = Boolean(op.implementation?.code);

    if (!isBuiltinName && !hasEndpoint && !hasCode) {
      fail(
        opPath,
        `"${op.operationName}" is not a builtin operation and has no remote endpoint. Use an exact builtin name from the catalog or a remote implementation.`,
        'UNKNOWN_OPERATION_NAME'
      );
      return;
    }

    // Input/output bindings: pipelines, references, duplicates.
    const seenInputNames = new Set<string>();
    const keptInputs: InputBinding[] = [];
    for (let i = 0; i < op.inputs.length; i++) {
      const input = op.inputs[i] as InputBinding;
      const inputPath = `${opPath}.inputs.${i}`;
      checkPipeline(inputPath, input, warnings);

      if (input.source === 'ui-element' && !elementIds.has(input.sourceId)) {
        fail(inputPath, `References unknown element "${input.sourceId}"`, 'UNKNOWN_ELEMENT');
      }
      if (input.source === 'state' && input.sourceId && !stateReads.has(input.sourceId)) {
        stateReads.set(input.sourceId, `input:${input.name}`);
      }

      if (def) {
        const flatNames = def.inputs
          .filter((spec) => !spec.name.includes('<'))
          .map((spec) => spec.name);
        const prefixes = def.structuredPrefixes ?? [];
        const dot = input.name.indexOf('.');
        if (dot > 0) {
          const prefix = input.name.slice(0, dot);
          if (!prefixes.includes(prefix)) {
            if (prefixes.length > 0) {
              fail(
                inputPath,
                `"${input.name}" uses prefix "${prefix}" but ${op.operationName} accepts ${prefixes
                  .map((p) => `${p}.<field>`)
                  .join(', ')}`,
                'INVALID_PREFIX'
              );
              continue;
            }
            warn(warnings, inputPath, `Unknown input "${input.name}" dropped`);
            continue;
          }
          if (input.name.slice(dot + 1).includes('.')) {
            warn(warnings, inputPath, `Nested field "${input.name}" flattened to a single level`);
          }
        } else if (!flatNames.includes(input.name)) {
          warn(warnings, inputPath, `Unknown input "${input.name}" dropped`);
          continue;
        }
      }

      if (seenInputNames.has(input.name)) {
        warn(warnings, inputPath, `Duplicate input "${input.name}"; the last one wins`);
        const existingIndex = keptInputs.findIndex((k) => k.name === input.name);
        if (existingIndex >= 0) keptInputs.splice(existingIndex, 1);
      }
      seenInputNames.add(input.name);
      keptInputs.push(input);
    }
    op.inputs = keptInputs;

    if (def) {
      // Required flat inputs present?
      for (const spec of def.inputs) {
        if (spec.required && !spec.name.includes('<') && !seenInputNames.has(spec.name)) {
          fail(opPath, `${op.operationName} requires input "${spec.name}"`, 'MISSING_INPUT');
        }
      }
      // Structured ops need at least one prefixed field.
      for (const prefix of def.structuredPrefixes ?? []) {
        if (![...seenInputNames].some((name) => name.startsWith(`${prefix}.`))) {
          fail(
            opPath,
            `${op.operationName} needs at least one "${prefix}.<field>" input`,
            'MISSING_INPUT'
          );
        }
      }
      // Outputs must exist on the manifest.
      const outputNames = new Set(def.outputs.map((spec) => spec.name));
      op.outputs = op.outputs.filter((output, outputIndex) => {
        if (!outputNames.has(output.name)) {
          warn(
            warnings,
            `${opPath}.outputs.${outputIndex}`,
            `${op.operationName} has no output "${output.name}"; binding dropped`
          );
          return false;
        }
        return true;
      });
    }

    // Output pipelines and element references apply to every execution type.
    op.outputs.forEach((output, outputIndex) => {
      checkPipeline(`${opPath}.outputs.${outputIndex}`, output, warnings);
      if (output.target === 'ui-element' && !elementIds.has(output.targetId)) {
        fail(
          `${opPath}.outputs.${outputIndex}`,
          `References unknown element "${output.targetId}"`,
          'UNKNOWN_ELEMENT'
        );
      }
    });

    // Track state writes for the seed check.
    op.outputs.forEach((output) => {
      if (output.target === 'state') stateWrites.add(output.targetId);
    });
    if (def) {
      const keyInput = op.inputs.find((input) => input.name === 'key');
      if (keyInput && keyInput.source === 'constant') {
        stateWrites.add(String(keyInput.value ?? keyInput.sourceId));
      }
    }
  });

  // Seed state keys that are read but never written.
  for (const [key, firstReader] of stateReads) {
    if (!stateWrites.has(key)) {
      const seed = firstReader === 'items' || firstReader === 'options' ? [] : null;
      contract.initialState = { ...(contract.initialState ?? {}), [key]: seed };
      warn(
        warnings,
        `initialState.${key}`,
        `State key "${key}" was read but never written; seeded with ${JSON.stringify(seed)}`
      );
    }
  }

  return { errors, warnings };
}

/** Validates a contract-shaped object structurally and against the manifests. */
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

  const clone = JSON.parse(JSON.stringify(parsed.data)) as ContractShape;
  const { errors, warnings } = checkAgainstManifests(clone);
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
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

  const operations = contract.operations.map((operation: OperationBinding) => {
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
