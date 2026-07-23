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
import {
  ELEMENT_MANIFESTS,
  INTEGRATION_CREDENTIALS,
  STYLE_ACCENTS,
  STYLE_THEMES,
  getOperationDef,
  getUiFragmentDef,
} from '../services/operations/registry';
import { TRANSFORMS } from '../services/operations/transforms';
import { expandUiFragment } from '../services/fragments/ui-fragments';

export const TransformFunctionSchema = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.any()).default({}),
});

const TransformPipelineSchema = z.array(TransformFunctionSchema);

/** Names the expr.evaluate grammar resolves without a variable binding. */
const EXPR_RESERVED_WORDS = new Set([
  'sqrt',
  'abs',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
  'pow',
  'pi',
  'e',
]);

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

interface TransformStep {
  type: string;
  parameters?: Record<string, unknown>;
}

/** A dynamic parameter reference: {"source": "state"|"element", "sourceId"}. */
function paramRefOf(value: unknown): { source: string; sourceId: unknown } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value as object);
  if (keys.length !== 2 || !keys.includes('source') || !keys.includes('sourceId')) return null;
  const ref = value as { source: unknown; sourceId: unknown };
  return typeof ref.source === 'string' ? { source: ref.source, sourceId: ref.sourceId } : null;
}

function checkPipeline(
  owner: string,
  binding: { transform?: TransformStep; transforms?: TransformStep[] },
  fail: (path: string, message: string, code: string) => void,
  checkRef?: (path: string, ref: { source: string; sourceId: unknown }) => void
): void {
  const steps = [...(binding.transforms ?? []), ...(binding.transform ? [binding.transform] : [])];
  for (const step of steps) {
    if (!TRANSFORMS[step.type]) {
      fail(
        owner,
        `Unknown transform "${step.type}"; available transforms: ${Object.keys(TRANSFORMS).join(
          ', '
        )}. Math on values belongs in expr.evaluate.`,
        'UNKNOWN_TRANSFORM'
      );
      continue;
    }
    for (const value of Object.values(step.parameters ?? {})) {
      const ref = paramRefOf(value);
      if (ref && checkRef) checkRef(owner, ref);
    }
  }
}

/**
 * Validates and normalizes a structurally valid contract against the part
 * manifests. Anything the parts cannot express (unknown operations, inputs,
 * outputs, or transforms) is a hard error: inside generation it feeds the
 * repair round, and if the model cannot recompose, creation fails instead of
 * silently shipping less than was asked. Mutations are limited to cosmetic
 * normalizations (defaulted knob values, deduplicated inputs, seeded state
 * keys), which are reported as warnings.
 */
export function checkAgainstManifests(contract: ContractShape): ManifestCheckResult {
  const errors: ManifestError[] = [];
  const warnings: ValidationWarning[] = [];
  const fail = (path: string, message: string, code: string) =>
    errors.push({ path, message, code });

  const INPUT_LIKE = new Set(['input', 'select', 'textarea']);
  const fixCenteredEntryRows = (element: UIElement, path: string) => {
    if (element.type !== 'container' && element.type !== 'form') return;
    const props = (element.properties ?? {}) as Record<string, unknown>;
    if (props.align !== 'center') return;
    if (props.direction === 'column') return;
    const children = element.children ?? [];
    const hasLabeledField = children.some(
      (child) =>
        INPUT_LIKE.has(child.type) &&
        Boolean((child.properties as Record<string, unknown> | undefined)?.label)
    );
    const hasOtherControl = children.some((child) => !INPUT_LIKE.has(child.type));
    if (hasLabeledField && hasOtherControl) {
      props.align = 'end';
      warn(
        warnings,
        `${path}.properties.align`,
        `Row mixes labeled fields with other controls; align "center" floats them, using "end"`
      );
    }
  };

  // Styling is cosmetic vocabulary: unknown values normalize with a warning.
  if (contract.styling) {
    const styling = contract.styling as { theme?: string; accent?: string };
    if (styling.theme && !(STYLE_THEMES as readonly string[]).includes(styling.theme)) {
      warn(
        warnings,
        'styling.theme',
        `"${styling.theme}" is not one of ${STYLE_THEMES.join('|')}; using "default"`
      );
      styling.theme = 'default';
    }
    if (styling.accent && !(STYLE_ACCENTS as readonly string[]).includes(styling.accent)) {
      warn(
        warnings,
        'styling.accent',
        `"${styling.accent}" is not one of ${STYLE_ACCENTS.join('|')}; accent removed`
      );
      delete styling.accent;
    }
  }

  const checkParamRef = (path: string, ref: { source: string; sourceId: unknown }) => {
    if (ref.source === 'element' && typeof ref.sourceId === 'string') {
      consumedElementIds.add(ref.sourceId);
    }
    if (ref.source !== 'state' && ref.source !== 'element') {
      fail(
        path,
        `Transform parameter reference source must be "state" or "element", got "${ref.source}"`,
        'INVALID_PARAM_REF'
      );
      return;
    }
    if (typeof ref.sourceId !== 'string' || ref.sourceId.length === 0) {
      fail(path, 'Transform parameter reference needs a sourceId', 'INVALID_PARAM_REF');
      return;
    }
    if (ref.source === 'element' && !elementIds.has(ref.sourceId)) {
      fail(
        path,
        `Transform parameter references unknown element "${ref.sourceId}"; existing element ids: ${knownElementIds()}`,
        'UNKNOWN_ELEMENT'
      );
      return;
    }
    if (ref.source === 'state' && !stateReads.has(ref.sourceId)) {
      stateReads.set(ref.sourceId, 'transform parameter');
    }
  };

  // Collect element ids, state reads, and state writes.
  const elementIds = new Set<string>();
  const knownElementIds = () => {
    const ids = [...elementIds];
    const shown = ids.slice(0, 30).join(', ');
    return ids.length > 30 ? `${shown}, ...` : shown;
  };
  const stateReads = new Map<string, string>(); // key -> first reading property
  const stateWrites = new Set<string>(Object.keys(contract.initialState ?? {}));
  const objectArrayKeys = new Set<string>();
  // Fields rows of a list-built key actually carry: append item.* inputs
  // (plus the generated id) and initialState seed objects. updateWhere's
  // set.* fields are tracked apart because new rows start without them.
  const appendFieldsByKey = new Map<string, Set<string>>();
  const laterFieldsByKey = new Map<string, Set<string>>();
  for (const op of contract.operations) {
    if (op.operationName.startsWith('list.')) {
      const keyInput = op.inputs.find((input) => input.name === 'key');
      if (!keyInput) continue;
      const key = String(keyInput.value ?? keyInput.sourceId);
      objectArrayKeys.add(key);
      if (op.operationName === 'list.append') {
        const fields = appendFieldsByKey.get(key) ?? new Set<string>(['id']);
        for (const input of op.inputs) {
          if (input.name.startsWith('item.')) fields.add(input.name.slice('item.'.length));
        }
        appendFieldsByKey.set(key, fields);
      } else {
        const later = laterFieldsByKey.get(key) ?? new Set<string>();
        for (const input of op.inputs) {
          if (input.name.startsWith('set.')) later.add(input.name.slice('set.'.length));
          if (input.name === 'field' && op.operationName === 'list.toggleField') {
            later.add(String(input.value ?? input.sourceId));
          }
        }
        laterFieldsByKey.set(key, later);
      }
    }
  }
  for (const [key, seed] of Object.entries(contract.initialState ?? {})) {
    if (!Array.isArray(seed)) continue;
    const objects = seed.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry)
    );
    if (objects.length === 0) continue;
    const fields = appendFieldsByKey.get(key) ?? new Set<string>();
    for (const entry of objects) {
      for (const field of Object.keys(entry)) fields.add(field);
    }
    appendFieldsByKey.set(key, fields);
  }

  // Transforms that read a row field while the value is still the original
  // object array. Anything else changes the shape and ends the check.
  const FIELD_READING_TRANSFORMS = new Set([
    'filterBy',
    'filterContains',
    'sortBy',
    'pluck',
    'sum',
  ]);
  const SHAPE_PRESERVING_TRANSFORMS = new Set([
    'filterBy',
    'filterContains',
    'filterTruthy',
    'filterFalsy',
    'sortBy',
  ]);
  const checkListFieldReads = (
    path: string,
    binding: {
      source?: string;
      sourceId?: string;
      transform?: TransformStep;
      transforms?: TransformStep[];
    }
  ) => {
    if (binding.source !== 'state' || !binding.sourceId) return;
    const fields = appendFieldsByKey.get(binding.sourceId);
    if (!fields) return;
    const steps = [
      ...(binding.transforms ?? []),
      ...(binding.transform ? [binding.transform] : []),
    ];
    for (const step of steps) {
      const field = step.parameters?.field;
      if (FIELD_READING_TRANSFORMS.has(step.type) && typeof field === 'string' && field) {
        if (!fields.has(field)) {
          const later = laterFieldsByKey.get(binding.sourceId);
          const hint = later?.has(field)
            ? `only a later list operation sets "${field}", so new rows start without it; give the append an item.${field} input with the starting value`
            : `add an item.${field} input to the append or fix the field name`;
          fail(
            path,
            `${step.type} reads field "${field}" from "${binding.sourceId}", but its rows carry: ${
              [...fields].join(', ') || 'nothing'
            }; ${hint}`,
            'LIST_FIELD_UNWRITTEN'
          );
        }
      }
      // A filter driven by the same control that feeds the append hides the
      // other rows the moment anything is added.
      if (step.type === 'filterBy' || step.type === 'filterContains') {
        for (const value of Object.values(step.parameters ?? {})) {
          const ref = paramRefOf(value);
          if (
            ref &&
            ref.source === 'element' &&
            appendElementsByKey.get(binding.sourceId)?.has(String(ref.sourceId))
          ) {
            fail(
              path,
              `The filter on "${binding.sourceId}" reads entry control "${String(ref.sourceId)}", which also feeds its list.append; every add would then hide the other rows. Use a separate filter control bound to its own state key, with an "All" option whose value is ""`,
              'FILTER_BOUND_TO_ENTRY'
            );
          }
        }
      }
      if (!SHAPE_PRESERVING_TRANSFORMS.has(step.type)) break;
    }
  };
  const operationIds = new Set(contract.operations.map((op) => op.id));
  const missingOperationRefs = new Set<string>();
  const referencedOperationIds = new Set<string>();
  // Element ids something consumes: operation inputs and outputs, or live
  // transform parameters. A control outside every one of these does nothing.
  const consumedElementIds = new Set<string>();
  const controlCandidates: Array<{ id: string; type: string; path: string }> = [];
  for (const op of contract.operations) {
    for (const input of op.inputs) {
      if (input.source === 'ui-element') consumedElementIds.add(input.sourceId);
    }
    for (const output of op.outputs) {
      if (output.target === 'ui-element') consumedElementIds.add(output.targetId);
    }
    // Legacy trigger wiring references elements too; normalization converts
    // it to event bindings only after this check runs.
    for (const trigger of op.triggers ?? []) {
      const elementId = (trigger.parameters as Record<string, unknown> | undefined)?.elementId;
      if (typeof elementId === 'string') consumedElementIds.add(elementId);
    }
  }
  // State keys some list element actually displays, and the entry controls
  // feeding each list-built key's append.
  const displayedListKeys = new Set<string>();
  const appendElementsByKey = new Map<string, Set<string>>();
  for (const op of contract.operations) {
    if (op.operationName !== 'list.append') continue;
    const keyInput = op.inputs.find((input) => input.name === 'key');
    if (!keyInput) continue;
    const key = String(keyInput.value ?? keyInput.sourceId);
    const sources = appendElementsByKey.get(key) ?? new Set<string>();
    for (const input of op.inputs) {
      if (input.name.startsWith('item.') && input.source === 'ui-element') {
        sources.add(input.sourceId);
      }
    }
    appendElementsByKey.set(key, sources);
  }
  const collectDisplayedKeys = (element: UIElement) => {
    if (element.type === 'list') {
      for (const binding of element.dataBindings ?? []) {
        if (binding.property === 'items' && binding.source === 'state') {
          displayedListKeys.add(binding.sourceId);
        }
      }
    }
    element.children?.forEach(collectDisplayedKeys);
  };

  const collectExpandedIds = (element: UIElement) => {
    elementIds.add(element.id);
    element.children?.forEach(collectExpandedIds);
  };
  walkElements(contract.elements as UIElement[], (element, path, inListTemplate) => {
    fixCenteredEntryRows(element, path);
    elementIds.add(element.id);
    if (element.type === 'list') {
      for (const binding of element.dataBindings ?? []) {
        if (binding.property === 'items' && binding.source === 'state') {
          displayedListKeys.add(binding.sourceId);
        }
      }
    }
    // Row controls act through their template's item scope; top-level
    // controls must be consumed by something to matter.
    const INTERACTIVE_TYPES = new Set(['button', 'input', 'select', 'textarea', 'checkbox']);
    if (
      INTERACTIVE_TYPES.has(element.type) &&
      !inListTemplate &&
      element.eventBindings.length === 0
    ) {
      controlCandidates.push({ id: element.id, type: element.type, path });
    }

    // Installed UI fragments: enforce their parameter contract. A fragment
    // instance renders its expanded subtree, so references to those ids
    // (e.g. "<instance>-input") are valid.
    const fragmentDef = getUiFragmentDef(element.type);
    if (fragmentDef) {
      try {
        const expanded = expandUiFragment(element, fragmentDef);
        collectExpandedIds(expanded);
        collectDisplayedKeys(expanded);
      } catch {
        // Param problems surface through the checks below.
      }
      const props = (element.properties ?? {}) as Record<string, unknown>;
      for (const param of fragmentDef.params) {
        const value = props[param.name];
        if (param.required && (value === undefined || value === '')) {
          fail(
            `${path}.properties.${param.name}`,
            `UI fragment ${element.type} requires the "${param.name}" parameter`,
            'MISSING_FRAGMENT_PARAM'
          );
          continue;
        }
        if (value !== undefined && param.type === 'operationId') {
          if (typeof value === 'string') {
            referencedOperationIds.add(value);
          }
          if (typeof value !== 'string' || !operationIds.has(value)) {
            fail(
              `${path}.properties.${param.name}`,
              `"${String(value)}" is not a defined operation id; defined: ${
                [...operationIds].join(', ') || 'none'
              }`,
              'UNKNOWN_OPERATION'
            );
          }
        }
      }
    }

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

    const INPUT_LIKE_TYPES = new Set(['input', 'textarea', 'select', 'checkbox']);
    element.dataBindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${path}.dataBindings.${bindingIndex}`;
      checkPipeline(bindingPath, binding, fail, checkParamRef);
      checkListFieldReads(bindingPath, binding);

      // Inside list templates auto-control is off and item bindings drive
      // the control; the ban applies only outside them.
      if (
        !inListTemplate &&
        INPUT_LIKE_TYPES.has(element.type) &&
        (binding.property === 'value' || binding.property === 'checked')
      ) {
        fail(
          bindingPath,
          `${element.type} elements are auto-controlled; never bind "${binding.property}". Read the element from operations ({"source": "ui-element"}) or from transform parameters ({"source": "element", "sourceId": "${element.id}"}).`,
          'BOUND_INPUT_VALUE'
        );
      }

      // Text-bound pipelines must end in a single value, or React receives a
      // list where a string belongs.
      if (binding.property === 'content' || binding.property === 'text') {
        const steps = [
          ...(binding.transforms ?? []),
          ...(binding.transform ? [binding.transform] : []),
        ];
        const last = steps[steps.length - 1];
        const lastDef = last ? TRANSFORMS[last.type] : undefined;
        if (lastDef?.output === 'array') {
          fail(
            bindingPath,
            `The "${binding.property}" pipeline ends in "${last!.type}", which returns a list; append a reducing step such as count, sum, or pick`,
            'PIPELINE_ENDS_IN_ARRAY'
          );
        }
      }
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
      checkPipeline(`${path}.visibleWhen.${conditionIndex}`, condition, fail, checkParamRef);
      checkListFieldReads(`${path}.visibleWhen.${conditionIndex}`, condition);
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
      referencedOperationIds.add(binding.operationId);
      if (!operationIds.has(binding.operationId)) {
        missingOperationRefs.add(binding.operationId);
        const defined = [...operationIds].join(', ') || 'none';
        fail(
          `${path}.eventBindings.${bindingIndex}`,
          `Event "${binding.event}" references unknown operation "${binding.operationId}"; defined operation ids: ${defined}`,
          'UNKNOWN_OPERATION'
        );
      }
    });
  });

  // A model that wires events but forgets the operations array needs the fix
  // stated outright, ahead of the per-binding errors.
  if (missingOperationRefs.size > 0 && contract.operations.length === 0) {
    errors.unshift({
      path: 'operations',
      message: `The contract has no "operations" array but elements reference ${
        missingOperationRefs.size
      } operation id(s): ${[...missingOperationRefs].join(
        ', '
      )}. Add a top-level "operations" array with one entry per referenced id.`,
      code: 'MISSING_OPERATIONS',
    });
  }

  // Operations against manifests.
  contract.operations.forEach((op, opIndex) => {
    const opPath = `operations.${opIndex}`;
    const def = getOperationDef(op.operationName);
    const isBuiltinName = Boolean(def);
    const hasEndpoint = Boolean(op.implementation?.endpoint);
    const hasCode = Boolean(op.implementation?.code);

    const endpoint = op.implementation?.endpoint ?? '';
    if (/https?:\/\/(api\.)?example\.(com|org|net)/i.test(endpoint)) {
      fail(
        `${opPath}.implementation.endpoint`,
        `"${endpoint}" is a placeholder, not a real service. Use an installed integration part if one fits, a real documented API recorded in the assumptions, or leave the feature out.`,
        'PLACEHOLDER_ENDPOINT'
      );
    }

    // An auth reference must name a configured integration credential.
    const auth = (op.implementation as { auth?: string } | undefined)?.auth;
    if (auth !== undefined) {
      const credential = INTEGRATION_CREDENTIALS.find((cred) => cred.name === auth);
      if (!credential) {
        const known = INTEGRATION_CREDENTIALS.map((cred) => cred.name);
        fail(
          `${opPath}.implementation.auth`,
          known.length > 0
            ? `"${auth}" is not a configured integration credential; available: ${known.join(', ')}`
            : `"${auth}" is not a configured integration credential; none are configured, so omit auth or ask the user to add one in Settings`,
          'UNKNOWN_CREDENTIAL'
        );
      } else if (
        credential.baseUrl &&
        !(op.implementation?.endpoint ?? '').startsWith(credential.baseUrl)
      ) {
        fail(
          `${opPath}.implementation.endpoint`,
          `Credential "${auth}" is confined to ${credential.baseUrl}; the endpoint must start with it`,
          'CREDENTIAL_CONFINEMENT'
        );
      }
    }

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
      checkPipeline(inputPath, input, fail, checkParamRef);
      checkListFieldReads(inputPath, input);

      if (input.source === 'ui-element' && !elementIds.has(input.sourceId)) {
        fail(
          inputPath,
          `References unknown element "${input.sourceId}"; existing element ids: ${knownElementIds()}`,
          'UNKNOWN_ELEMENT'
        );
      }
      if (input.source === 'state' && input.sourceId && !stateReads.has(input.sourceId)) {
        stateReads.set(input.sourceId, `input:${input.name}`);
      }

      if (def) {
        const flatNames = def.inputs
          .filter((spec) => !spec.name.includes('<'))
          .map((spec) => spec.name);
        const prefixes = def.structuredPrefixes ?? [];
        const accepted =
          [...flatNames, ...prefixes.map((p) => `${p}.<field>`)].join(', ') || 'none';
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
            fail(
              inputPath,
              `${op.operationName} has no input "${input.name}"; it accepts: ${accepted}`,
              'UNKNOWN_INPUT'
            );
            continue;
          }
          if (input.name.slice(dot + 1).includes('.')) {
            warn(warnings, inputPath, `Nested field "${input.name}" flattened to a single level`);
          }
        } else if (!flatNames.includes(input.name)) {
          fail(
            inputPath,
            `${op.operationName} has no input "${input.name}"; it accepts: ${accepted}`,
            'UNKNOWN_INPUT'
          );
          continue;
        }

        // A numbers-array input reading a list-built state key (objects by
        // construction) silently computes over nothing without a projection.
        const spec = def.inputs.find((candidate) => candidate.name === input.name);
        const wantsNumbers =
          spec?.type === 'array' && /number/i.test(spec.description ?? '');
        const hasTransforms =
          (input.transforms?.length ?? 0) > 0 || Boolean(input.transform);
        if (
          wantsNumbers &&
          !hasTransforms &&
          input.source === 'state' &&
          objectArrayKeys.has(input.sourceId)
        ) {
          fail(
            inputPath,
            `"${input.sourceId}" holds objects (built by a list operation); project the numeric field first, e.g. transforms [{"type": "pluck", "parameters": {"field": "<field>"}}]`,
            'NEEDS_PROJECTION'
          );
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
      // A structured prefix demands at least one field only when its
      // placeholder spec is required (list.append's item.<field> is; expr's
      // var.<name> is optional).
      for (const prefix of def.structuredPrefixes ?? []) {
        const placeholder = def.inputs.find((spec) => spec.name.startsWith(`${prefix}.`));
        if (placeholder && placeholder.required === false) continue;
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
      op.outputs.forEach((output, outputIndex) => {
        if (!outputNames.has(output.name)) {
          fail(
            `${opPath}.outputs.${outputIndex}`,
            `${op.operationName} has no output "${output.name}"; it provides: ${
              [...outputNames].join(', ') || 'none'
            }`,
            'UNKNOWN_OUTPUT'
          );
        }
      });

      // A constant expr.evaluate expression can be linted against its bound
      // variables here; at runtime a mismatch surfaces only when someone
      // clicks the button.
      if (op.operationName === 'expr.evaluate') {
        const expression = op.inputs.find(
          (input) => input.name === 'expression' && input.source === 'constant'
        );
        const bound = new Set(
          [...seenInputNames]
            .filter((name) => name.startsWith('var.'))
            .map((name) => name.slice('var.'.length))
        );
        const source = String(expression?.value ?? expression?.sourceId ?? '');
        if (expression && source) {
          const identifiers = source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
          for (const identifier of new Set(identifiers)) {
            if (EXPR_RESERVED_WORDS.has(identifier)) continue;
            if (!bound.has(identifier)) {
              fail(
                opPath,
                `expr.evaluate expression uses "${identifier}" but binds ${
                  bound.size ? `only: ${[...bound].join(', ')}` : 'no variables'
                }; add an input named "var.${identifier}" or rename it in the expression`,
                'EXPR_UNBOUND_VARIABLE'
              );
            }
          }
        }
      }
    }

    // Output pipelines and element references apply to every execution type.
    op.outputs.forEach((output, outputIndex) => {
      checkPipeline(`${opPath}.outputs.${outputIndex}`, output, fail, checkParamRef);
      if (output.target === 'ui-element' && !elementIds.has(output.targetId)) {
        fail(
          `${opPath}.outputs.${outputIndex}`,
          `References unknown element "${output.targetId}"; existing element ids: ${knownElementIds()}`,
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

  // An operation nothing runs is a dead feature: some binding, tick, or
  // fragment parameter must reference it.
  contract.operations.forEach((op, opIndex) => {
    const wired = referencedOperationIds.has(op.id) || (op.triggers ?? []).length > 0;
    if (!wired) {
      fail(
        `operations.${opIndex}`,
        `Nothing runs operation "${op.id}"; wire it to an element event (a click, change, or timer tick) or remove it`,
        'ORPHAN_OPERATION'
      );
    }
  });

  // Editing a list nothing ever fills is a feature that can never happen.
  const LIST_EDIT_OPERATIONS = new Set(['list.updateWhere', 'list.removeWhere', 'list.toggleField']);
  contract.operations.forEach((op, opIndex) => {
    if (!LIST_EDIT_OPERATIONS.has(op.operationName)) return;
    const keyInput = op.inputs.find((input) => input.name === 'key');
    if (!keyInput) return;
    const key = String(keyInput.value ?? keyInput.sourceId);
    if (!appendFieldsByKey.has(key)) {
      fail(
        `operations.${opIndex}`,
        `${op.operationName} edits "${key}" but nothing ever fills it; add a list.append flow with entry controls, or seed initialState.${key} with starting rows`,
        'LIST_NEVER_FILLED'
      );
    }
  });

  // Rows someone adds must be visible somewhere.
  for (const key of appendElementsByKey.keys()) {
    if (!displayedListKeys.has(key)) {
      fail(
        'operations',
        `list.append fills "${key}" but no list element displays it; bind a list element's "items" to "${key}"`,
        'LIST_NOT_DISPLAYED'
      );
    }
  }

  // A control nothing consumes does nothing when used.
  for (const control of controlCandidates) {
    if (consumedElementIds.has(control.id)) continue;
    const wiring =
      control.type === 'button'
        ? 'give it an eventBinding that runs an operation'
        : 'read it from an operation input ({"source": "ui-element"}), reference it live from a filter parameter ({"source": "element"}), or give it a change binding';
    fail(
      control.path,
      `${control.type} "${control.id}" affects nothing: ${wiring}, or remove it`,
      'DEAD_CONTROL'
    );
  }

  // Seed state keys that are read but never written. An empty array for an
  // array-shaped reader is the normal omitted-seed case and stays silent; a
  // null seed means a key no operation writes, which usually flags a typo.
  for (const [key, firstReader] of stateReads) {
    if (!stateWrites.has(key)) {
      const seed = firstReader === 'items' || firstReader === 'options' ? [] : null;
      contract.initialState = { ...(contract.initialState ?? {}), [key]: seed };
      if (seed === null) {
        warn(
          warnings,
          `initialState.${key}`,
          `State key "${key}" was read but never written; seeded with null`
        );
      }
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
