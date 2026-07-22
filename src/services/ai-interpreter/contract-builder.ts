/**
 * Contract Builder - generates a runnable Contract from a Blueprint with the
 * LLM, constrained to composing the prewritten parts: the prompt catalog is
 * generated from the part manifests, the LLM schema forbids code, and the
 * composition is validated against the manifests inside the repair loop
 * before the runtime receives it.
 */

import { Blueprint } from '../../types/blueprint';
import {
  Contract,
  OperationBinding,
  UIElement,
  ValidationResult,
  ValidationWarning,
} from '../../types/contract';
import { ComponentRepository } from '../../types/repository';
import { LLMClient, LLMMessage } from './llm-client';
import { generateValidatedJson } from './llm-json';
import {
  LlmContractSchema,
  checkAgainstManifests,
  formatManifestErrors,
  normalizeContract,
  validateContractObject,
} from '../../schemas/contract';
import type { ContractShape } from '../../schemas/contract';
import {
  BUILTIN_OPERATIONS,
  ELEMENT_MANIFESTS,
  INTRINSIC_ELEMENT_TYPES,
  isKnownElementType,
} from '../operations/registry';
import { TRANSFORMS } from '../operations/transforms';

export class ContractBuilder {
  private lastWarnings: ValidationWarning[] = [];

  constructor(
    private repository: ComponentRepository,
    private llmClient: LLMClient = new LLMClient()
  ) {}

  /** Degradations applied to the most recently generated contract. */
  getLastWarnings(): ValidationWarning[] {
    return this.lastWarnings;
  }

  async generateFromBlueprint(blueprint: Blueprint): Promise<Contract> {
    const catalog = await this.renderCatalog();
    const messages: LLMMessage[] = [
      { role: 'system', content: buildContractSystemPrompt(catalog) },
      {
        role: 'user',
        content: `Generate the contract for this blueprint:\n\n${JSON.stringify(
          {
            description: blueprint.description,
            goal: blueprint.goal,
            requiredCapabilities: blueprint.requiredCapabilities,
            uiElements: blueprint.uiElements,
            operations: blueprint.operations,
          },
          null,
          2
        )}`,
      },
    ];

    let warnings: ValidationWarning[] = [];
    const shape = await generateValidatedJson(this.llmClient, messages, LlmContractSchema, {
      label: 'Contract',
      maxTokens: 16000,
      semanticCheck: (candidate) => {
        const result = checkAgainstManifests(candidate as ContractShape);
        warnings = result.warnings;
        return result.errors.length > 0 ? [formatManifestErrors(result.errors)] : [];
      },
    });

    this.lastWarnings = warnings;
    if (warnings.length > 0) {
      console.warn('Contract adjusted against part manifests:', warnings);
    }
    return this.postProcess(shape, blueprint);
  }

  validateContract(contract: unknown): ValidationResult {
    const data =
      contract && typeof contract === 'object' && 'toObject' in (contract as object)
        ? (contract as { toObject(): unknown }).toObject()
        : contract;
    return validateContractObject(data);
  }

  private async renderCatalog(): Promise<string> {
    const elementLines = Object.values(ELEMENT_MANIFESTS).flatMap((manifest) => {
      const lines = [`- ${manifest.type}: ${manifest.description}`];
      if (manifest.knobs.length > 0) {
        const knobs = manifest.knobs
          .map((knob) =>
            knob.type === 'enum'
              ? `${knob.name}: ${(knob.values ?? []).join('|')} (default ${knob.default})`
              : `${knob.name}: ${knob.type}`
          )
          .join('; ');
        lines.push(`  knobs: ${knobs}`);
      }
      if (manifest.bindableProps?.length) {
        lines.push(`  bindable: ${manifest.bindableProps.join(', ')}`);
      }
      lines.push(`  howto: ${manifest.howto}`);
      if (manifest.example) {
        lines.push(`  example: ${JSON.stringify(manifest.example)}`);
      }
      return lines;
    });

    const operationLines = Object.values(BUILTIN_OPERATIONS)
      .filter((def) => !def.hidden)
      .flatMap((def) => {
        const inputs =
          def.inputs
            .map((spec) => `${spec.name}${spec.required ? '' : '?'}: ${spec.type}`)
            .join(', ') || 'none';
        const outputs = def.outputs.map((spec) => `${spec.name}: ${spec.type}`).join(', ') || 'none';
        const lines = [`- ${def.name} (inputs: ${inputs}; outputs: ${outputs}): ${def.description}`];
        if (def.howto) lines.push(`  howto: ${def.howto}`);
        if (def.example) lines.push(`  example: ${JSON.stringify(def.example)}`);
        return lines;
      });

    const transformLines = Object.values(TRANSFORMS).map((def) => {
      const params = def.parameters.map((p) => p.name).join(', ');
      return `- ${def.name}${params ? ` {${params}}` : ''}: ${def.description}`;
    });

    // Custom (non-builtin) operations registered in the repository, if any.
    let customLines: string[] = [];
    try {
      const customOps = await this.repository.queryOperations({});
      customLines = customOps
        .filter((op) => !(op.name in BUILTIN_OPERATIONS))
        .map((op) => {
          const inputs = op.inputs.map((i) => `${i.name}: ${i.type}`).join(', ') || 'none';
          const outputs = op.outputs.map((o) => `${o.name}: ${o.type}`).join(', ') || 'none';
          return `- ${op.name} (executionType: ${op.executionType}; inputs: ${inputs}; outputs: ${outputs}): ${op.description}`;
        });
    } catch {
      // Repository unavailable; the builtin catalog is enough to generate.
    }

    return [
      'ELEMENT PARTS (compose these; plain HTML tag names are also accepted):',
      ...elementLines,
      '',
      'BUILTIN OPERATIONS (use the exact name with executionType "builtin"):',
      ...operationLines,
      '',
      'TRANSFORMS (compose into "transforms" pipelines; applied in order):',
      ...transformLines,
      ...(customLines.length ? ['', 'REGISTERED CUSTOM OPERATIONS:', ...customLines] : []),
    ].join('\n');
  }

  private postProcess(shape: ContractShape, blueprint: Blueprint): Contract {
    const warnings: string[] = [];

    // Unique ids across the element tree and operations.
    const seenIds = new Set<string>();
    const uniqueId = (id: string): string => {
      let candidate = id;
      let n = 2;
      while (seenIds.has(candidate)) {
        candidate = `${id}-${n++}`;
      }
      seenIds.add(candidate);
      return candidate;
    };

    const fixElement = (element: UIElement): UIElement => {
      const id = uniqueId(element.id);
      if (id !== element.id) {
        warnings.push(`Renamed duplicate element id "${element.id}" to "${id}"`);
      }
      let type = element.type;
      if (!isKnownElementType(type)) {
        if (INTRINSIC_ELEMENT_TYPES.has(type.toLowerCase())) {
          type = type.toLowerCase();
        } else {
          warnings.push(`Unknown element type "${type}" rendered as container`);
          type = 'container';
        }
      }
      return {
        ...element,
        id,
        type,
        children: element.children?.map(fixElement),
      };
    };
    const elements = (shape.elements as UIElement[]).map(fixElement);

    // Resolve execution types (unknown names were already repaired or errored).
    const operations: OperationBinding[] = (shape.operations as OperationBinding[]).map((op) => {
      const id = uniqueId(op.id);
      if (BUILTIN_OPERATIONS[op.operationName]) {
        return { ...op, id, executionType: 'builtin', implementation: undefined };
      }
      if (op.implementation?.endpoint) {
        return {
          ...op,
          id,
          executionType: 'remote',
          implementation: { ...op.implementation, type: 'remote' },
        };
      }
      return { ...op, id };
    });

    const now = new Date();
    const contract: Contract = {
      name: shape.name,
      version: shape.version,
      initialState: shape.initialState,
      elements,
      operations,
      layout: shape.layout,
      styling: shape.styling,
      metadata: {
        createdAt: shape.metadata?.createdAt ?? now,
        updatedAt: now,
        version: shape.metadata?.version ?? shape.version,
        description: shape.metadata?.description ?? blueprint.goal,
        tags: shape.metadata?.tags,
        author: shape.metadata?.author,
      },
    };

    if (warnings.length) {
      console.warn('Contract post-processing adjustments:', warnings);
    }
    return normalizeContract(contract);
  }
}

function buildContractSystemPrompt(catalog: string): string {
  return `You compose a Contract JSON from prewritten parts; a runtime renders it into a live interactive app. You configure parts; you NEVER write code. Return one JSON object only: no prose, no code fences.

CONTRACT SHAPE:
{
  "name": "kebab-case-name",
  "version": "1.0.0",
  "initialState": { "stateKey": <seed value> },
  "elements": [ { "id", "type", "properties": {}, "dataBindings": [], "eventBindings": [], "visibleWhen"?, "children": [...] } ],
  "operations": [ { "id", "operationName", "executionType", "inputs": [], "outputs": [], "triggers": [] } ],
  "layout": { "type": "flex", "properties": { "flexDirection": "column", "gap": "12px", "padding": "16px" } },
  "styling": { "theme": "default" }
}
Do not include a "metadata" field; it is added automatically. "triggers" must always be [].

RUNTIME RULES (follow exactly):
1. State is a flat map. Operations write it; display elements read it with dataBindings {"property", "source": "state", "sourceId": "<stateKey>"}. Seed every state key you read in "initialState".
2. Inputs, selects, and checkboxes are auto-controlled. Give each an id; NEVER bind its value. Operations read them with an InputBinding {"name": "<param>", "source": "ui-element", "sourceId": "<element id>"}. Do not place them inside list children.
3. Wire interactions only with eventBindings on elements: {"event": "click" | "change" | "submit", "operationId": "<operation id>"}.
4. A "list" element repeats its children once per entry of the array bound to its "items" property. Inside those children, read entry fields with source "item" and a dot-path sourceId (e.g. "title"; "" for the whole entry), including operation InputBindings {"source": "item", "sourceId": "id"}.
5. Other input sources: {"source": "state", "sourceId": "<stateKey>"} and {"source": "constant", "sourceId": "<text>"}. For non-string constants set the typed "value" field: {"source": "constant", "sourceId": "true", "value": true}. Outputs route results: {"name": "<output name>", "target": "state", "targetId": "<stateKey>"} or {"target": "ui-element", "targetId": "<element id>"} to set an element's value.
6. Structured operation inputs use dotted names: list.append takes one input per item field named "item.<field>" (never "item.id"; the part generates ids), list.updateWhere writes fields via "set.<field>". Use the parseNumber transform on numeric fields fed from text inputs.
7. Derived values need no operation: attach a "transforms" pipeline (applied in order) to a dataBinding, e.g. filterBy then count for "N items left", or sum then round then format for totals. Bindings re-resolve on every state change.
8. Conditional rendering: "visibleWhen": {"source": "state"|"item", "sourceId", "operator": "truthy"|"falsy"|"empty"|"notEmpty"|"equals"|"notEquals"|"gt"|"gte"|"lt"|"lte", "value"?, "transforms"?}. An array of conditions means all must hold. Combine with state.set for tabs and view switching.
9. Element knobs (variant, size, role, direction, gap, align, justify, padding, label, emptyText) are declared per part below; use only listed values.
10. executionType "builtin" requires an exact operation name from the catalog. executionType "remote" is configuration of an HTTP call: "implementation": {"type": "remote", "endpoint": "https://...", "method": "GET"|"POST", "headers": {}}; "{name}" placeholders in the endpoint fill from same-named inputs, other inputs become query parameters (GET) or the JSON body. There is no way to include code and none is needed.

${catalog}

EXAMPLE (expense tracker; note the derived total and count need no operations):
{
  "name": "expense-tracker",
  "version": "1.0.0",
  "initialState": { "expenses": [] },
  "elements": [
    { "id": "title", "type": "text", "properties": { "content": "Expenses", "role": "title" }, "dataBindings": [], "eventBindings": [] },
    { "id": "entry", "type": "container", "properties": { "direction": "row", "gap": "8", "align": "end" }, "dataBindings": [], "eventBindings": [], "children": [
      { "id": "desc-in", "type": "input", "properties": { "placeholder": "Description", "label": "What" }, "dataBindings": [], "eventBindings": [] },
      { "id": "amt-in", "type": "input", "properties": { "placeholder": "0.00", "type": "number", "label": "Amount" }, "dataBindings": [], "eventBindings": [] },
      { "id": "add-btn", "type": "button", "properties": { "text": "Add", "variant": "primary" }, "dataBindings": [], "eventBindings": [ { "event": "click", "operationId": "op-add" } ] } ] },
    { "id": "rows", "type": "list", "properties": { "emptyText": "No expenses yet" },
      "dataBindings": [ { "property": "items", "source": "state", "sourceId": "expenses" } ], "eventBindings": [],
      "children": [
        { "id": "r-desc", "type": "text", "properties": {}, "dataBindings": [ { "property": "content", "source": "item", "sourceId": "description" } ], "eventBindings": [] },
        { "id": "r-amt", "type": "text", "properties": { "role": "caption" }, "dataBindings": [ { "property": "content", "source": "item", "sourceId": "amount", "transforms": [ { "type": "round", "parameters": { "decimals": 2 } }, { "type": "format", "parameters": { "template": "$ {{value}}" } } ] } ], "eventBindings": [] },
        { "id": "r-del", "type": "button", "properties": { "text": "Delete", "variant": "danger", "size": "sm" }, "dataBindings": [], "eventBindings": [ { "event": "click", "operationId": "op-del" } ] } ] },
    { "id": "summary", "type": "container", "properties": { "direction": "row", "justify": "between" }, "visibleWhen": { "source": "state", "sourceId": "expenses", "operator": "notEmpty" }, "dataBindings": [], "eventBindings": [], "children": [
      { "id": "count", "type": "text", "properties": { "role": "caption" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "expenses", "transforms": [ { "type": "count", "parameters": {} }, { "type": "format", "parameters": { "template": "{{value}} expenses" } } ] } ], "eventBindings": [] },
      { "id": "total", "type": "text", "properties": { "role": "subtitle" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "expenses", "transforms": [ { "type": "sum", "parameters": { "field": "amount" } }, { "type": "round", "parameters": { "decimals": 2 } }, { "type": "format", "parameters": { "template": "Total: $ {{value}}" } } ] } ], "eventBindings": [] } ] }
  ],
  "operations": [
    { "id": "op-add", "operationName": "list.append", "executionType": "builtin",
      "inputs": [
        { "name": "key", "source": "constant", "sourceId": "expenses" },
        { "name": "item.description", "source": "ui-element", "sourceId": "desc-in" },
        { "name": "item.amount", "source": "ui-element", "sourceId": "amt-in", "transforms": [ { "type": "parseNumber", "parameters": {} } ] } ],
      "outputs": [
        { "name": "reset", "target": "ui-element", "targetId": "desc-in" },
        { "name": "reset", "target": "ui-element", "targetId": "amt-in" } ], "triggers": [] },
    { "id": "op-del", "operationName": "list.removeWhere", "executionType": "builtin",
      "inputs": [
        { "name": "key", "source": "constant", "sourceId": "expenses" },
        { "name": "value", "source": "item", "sourceId": "id" } ], "outputs": [], "triggers": [] }
  ],
  "layout": { "type": "flex", "properties": { "flexDirection": "column", "gap": "12px", "padding": "16px" } },
  "styling": { "theme": "default" }
}

Design the smallest contract that fully satisfies the blueprint. Every eventBinding.operationId must match an operation id; every state key you read must be seeded or written; every part, knob value, operation, and transform must come from the catalog above.`;
}
