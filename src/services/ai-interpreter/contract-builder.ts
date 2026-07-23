/**
 * Contract Builder - generates a runnable Contract from a Blueprint with the
 * LLM, constrained to composing the prewritten parts: the prompt catalog is
 * generated from the part manifests, the LLM schema forbids code, and the
 * composition is validated against the manifests inside the repair loop
 * before the runtime receives it.
 */

import { Blueprint, ComposedSpec } from '../../types/blueprint';
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
  ComposedResponseSchema,
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
  FRAGMENT_OPERATIONS,
  INTRINSIC_ELEMENT_TYPES,
  STYLE_ACCENTS,
  STYLE_THEMES,
  getOperationDef,
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

  /**
   * Single-call creation: one model round trip returns the contract plus a
   * small spec header (goal, assumptions, open questions). Validation matches
   * the blueprint path exactly: schema parse, manifest check, repair round.
   */
  async composeFromDescription(
    description: string,
    onPartial?: (accumulated: string) => void
  ): Promise<{ contract: Contract; spec: ComposedSpec }> {
    const catalog = await this.renderCatalog();
    const messages: LLMMessage[] = [
      { role: 'user', content: `Build an app for this request:\n\n${description}` },
    ];

    let warnings: ValidationWarning[] = [];
    const composed = await generateValidatedJson(this.llmClient, messages, ComposedResponseSchema, {
      label: 'Contract',
      maxTokens: 16000,
      systemBlocks: [
        { text: buildBasePrompt(catalog), cache: true },
        { text: CREATE_PROMPT_SECTION },
      ],
      onPartial,
      semanticCheck: (candidate) => {
        const result = checkAgainstManifests(candidate.contract as ContractShape);
        warnings = result.warnings;
        return result.errors.length > 0 ? [formatManifestErrors(result.errors)] : [];
      },
    });

    this.lastWarnings = warnings;
    if (warnings.length > 0) {
      console.warn('Contract adjusted against part manifests:', warnings);
    }
    const spec = composed.spec;
    const contract = this.postProcess(
      composed.contract as ContractShape,
      spec.goal || description
    );
    return { contract, spec };
  }

  async generateFromBlueprint(blueprint: Blueprint): Promise<Contract> {
    const catalog = await this.renderCatalog();
    const messages: LLMMessage[] = [
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
      systemBlocks: [
        { text: buildBasePrompt(catalog), cache: true },
        { text: BLUEPRINT_PROMPT_SECTION },
      ],
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
    return this.postProcess(shape, blueprint.goal);
  }

  /**
   * Applies a natural-language edit to an existing contract. Preservation is
   * a property of id stability: the prompt requires kept elements/operations
   * to keep their ids, and an id that changes its kind of part is repaired.
   */
  async editContract(current: Contract | ContractShape, instruction: string): Promise<Contract> {
    const currentObject =
      typeof (current as { toObject?: () => unknown }).toObject === 'function'
        ? (current as unknown as { toObject(): Contract }).toObject()
        : (current as Contract);

    const catalog = await this.renderCatalog();
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: `Current contract:\n${JSON.stringify(currentObject, null, 2)}\n\nApply this change and return the complete updated contract:\n${instruction}`,
      },
    ];
    const systemBlocks = [
      { text: buildBasePrompt(catalog), cache: true },
      { text: EDIT_PROMPT_SECTION },
    ];

    const stableKinds = new Map<string, string>();
    const collectKinds = (elements: UIElement[]) => {
      for (const element of elements) {
        stableKinds.set(`element:${element.id}`, element.type);
        if (element.children) collectKinds(element.children);
      }
    };
    collectKinds(currentObject.elements ?? []);
    for (const op of currentObject.operations ?? []) {
      stableKinds.set(`operation:${op.id}`, op.operationName);
    }

    let warnings: ValidationWarning[] = [];
    const shape = await generateValidatedJson(this.llmClient, messages, LlmContractSchema, {
      label: 'Contract',
      maxTokens: 16000,
      systemBlocks,
      semanticCheck: (candidate) => {
        const result = checkAgainstManifests(candidate as ContractShape);
        warnings = result.warnings;
        const problems =
          result.errors.length > 0 ? [formatManifestErrors(result.errors)] : [];
        problems.push(...this.checkIdStability(candidate as ContractShape, stableKinds));
        return problems;
      },
    });

    // Ids that disappeared are legitimate removals; note them for the caller.
    const remaining = new Set<string>();
    const collectRemaining = (elements: UIElement[]) => {
      for (const element of elements) {
        remaining.add(`element:${element.id}`);
        if (element.children) collectRemaining(element.children as UIElement[]);
      }
    };
    collectRemaining(shape.elements as UIElement[]);
    for (const op of shape.operations) remaining.add(`operation:${op.id}`);
    for (const [key] of stableKinds) {
      if (!remaining.has(key)) {
        const [kind, id] = key.split(':');
        warnings.push({
          path: kind === 'element' ? 'elements' : 'operations',
          message: `Edit removed ${kind} "${id}"`,
          code: 'EDIT_REMOVED_PART',
        });
      }
    }

    this.lastWarnings = warnings;
    if (warnings.length > 0) {
      console.warn('Contract edit adjustments:', warnings);
    }

    // Preserve creation metadata; postProcess stamps updatedAt.
    const merged: ContractShape = {
      ...shape,
      metadata: shape.metadata ?? {
        createdAt: currentObject.metadata?.createdAt ?? new Date(),
        updatedAt: new Date(),
        version: currentObject.metadata?.version ?? shape.version,
        description: currentObject.metadata?.description,
        tags: currentObject.metadata?.tags,
        author: currentObject.metadata?.author,
      },
    };
    return this.postProcess(merged, currentObject.metadata?.description ?? currentObject.name);
  }

  /** An id kept across the edit must keep its kind of part. */
  private checkIdStability(candidate: ContractShape, stableKinds: Map<string, string>): string[] {
    const problems: string[] = [];
    const checkElement = (element: UIElement, path: string) => {
      const known = stableKinds.get(`element:${element.id}`);
      if (known !== undefined && known !== element.type) {
        problems.push(
          `${path}: element id "${element.id}" was type "${known}" and must keep it (use a new id for a different part; reused ids preserve user state)`
        );
      }
      element.children?.forEach((child, i) =>
        checkElement(child as UIElement, `${path}.children.${i}`)
      );
    };
    (candidate.elements as UIElement[]).forEach((element, i) =>
      checkElement(element, `elements.${i}`)
    );
    candidate.operations.forEach((op, i) => {
      const known = stableKinds.get(`operation:${op.id}`);
      if (known !== undefined && known !== op.operationName) {
        problems.push(
          `operations.${i}: operation id "${op.id}" was "${known}" and must keep it (use a new id for a different operation)`
        );
      }
    });
    return problems;
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

    const fragmentLines = Object.values(FRAGMENT_OPERATIONS).flatMap((def) => {
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

    // Custom (non-builtin) operations registered in the repository, if any.
    // Sorted by name so the prompt prefix stays byte-stable for caching.
    let customLines: string[] = [];
    try {
      const customOps = await this.repository.queryOperations({});
      customLines = customOps
        .filter((op) => !getOperationDef(op.name))
        .sort((a, b) => a.name.localeCompare(b.name))
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
      ...(fragmentLines.length
        ? ['', 'INSTALLED PART OPERATIONS (use the exact name with executionType "builtin"):', ...fragmentLines]
        : []),
      ...(customLines.length ? ['', 'REGISTERED CUSTOM OPERATIONS:', ...customLines] : []),
    ].join('\n');
  }

  private postProcess(shape: ContractShape, fallbackDescription?: string): Contract {
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
      if (getOperationDef(op.operationName)) {
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

    // An omitted layout materializes as empty flex properties; fill the
    // standard column so omission renders identically to the explicit form.
    const layout =
      shape.layout && Object.keys(shape.layout.properties ?? {}).length > 0
        ? shape.layout
        : {
            type: 'flex' as const,
            properties: { flexDirection: 'column', gap: '12px', padding: '16px' },
          };

    const now = new Date();
    const contract: Contract = {
      name: shape.name,
      version: shape.version,
      initialState: shape.initialState,
      elements,
      operations,
      layout,
      styling: shape.styling,
      metadata: {
        createdAt: shape.metadata?.createdAt ?? now,
        updatedAt: now,
        version: shape.metadata?.version ?? shape.version,
        description: shape.metadata?.description ?? fallbackDescription,
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

const CREATE_PROMPT_SECTION = `CREATE MODE:
You are given a user's request for a new app. Respond with ONE JSON object:
{ "spec": { "goal": "one sentence stating what the app does", "assumptions": ["choice you made where the request was open"], "openQuestions": ["question whose answer would change the app"] }, "contract": <the contract> }
Make reasonable choices instead of blocking on questions; record them as assumptions. Keep both lists short; they are often empty. Return the JSON only: no prose, no code fences.`;

const BLUEPRINT_PROMPT_SECTION = `BLUEPRINT MODE:
You are given a reviewed blueprint (goal, planned elements and operations). Produce the contract that realizes it, following the blueprint's intent even where you would design differently. Return the contract JSON object only: no prose, no code fences.`;

const EDIT_PROMPT_SECTION = `EDIT MODE:
You are updating an EXISTING app, given its current contract and a change request. Return the COMPLETE updated contract JSON only: no prose, no code fences.
- Change only what the instruction requires; keep everything else exactly as it is.
- Keep the ids of every element and operation you retain. State is keyed by these ids; a changed id loses the user's data. Give NEW parts new ids.
- Keep existing initialState keys and their seeds; new state keys follow rule 1 (seed only what needs a non-empty start).
- Removing parts the instruction makes obsolete is fine; do not remove anything else.`;

function buildBasePrompt(catalog: string): string {
  return `You compose a Contract JSON from prewritten parts; a runtime renders it into a live interactive app. You configure parts; you NEVER write code.

CONTRACT SHAPE (omit every field marked ?, every empty array or object, and every default):
{
  "name": "kebab-case-name",
  "version": "1.0.0",
  "initialState"?: { "<stateKey>": <seed> },
  "elements": [ { "id", "type", "properties"?, "dataBindings"?, "eventBindings"?, "visibleWhen"?, "children"? } ],
  "operations": [ { "id", "operationName", "inputs"?, "outputs"?, "implementation"? } ],
  "styling"?: { "theme": ${STYLE_THEMES.map((t) => `"${t}"`).join(' | ')}, "accent"?: ${STYLE_ACCENTS.map((a) => `"${a}"`).join(' | ')} }
}
Never emit "metadata", "triggers", "executionType", or "layout": the runtime derives them (executionType from the operation name, or remote when "implementation" carries an endpoint; the default layout is a padded 12px column). Omit "styling" for the standard light look; set a theme or accent when the user asks for one or the app's character clearly calls for it, e.g. "terminal" for a developer tool or "paper" for a journal.

RUNTIME RULES (follow exactly):
1. State is a flat map. Operations write it; display elements read it with dataBindings {"property", "source": "state", "sourceId": "<stateKey>"}. Unwritten keys start empty (arrays read as []); add an "initialState" entry only when a key needs a non-empty start, e.g. a default tab name or preset options.
2. Inputs, selects, and checkboxes are auto-controlled. Give each an id; NEVER bind its value. Operations read them with an InputBinding {"name": "<param>", "source": "ui-element", "sourceId": "<element id>"}. Do not place them inside list children.
3. Wire interactions only with eventBindings on elements: {"event": "click" | "change" | "submit", "operationId": "<operation id>"}.
4. A "list" element repeats its children once per entry of the array bound to its "items" property. Inside those children, read entry fields with source "item" and a dot-path sourceId (e.g. "title"; "" for the whole entry), including operation InputBindings {"source": "item", "sourceId": "id"}.
5. Other input sources: {"source": "state", "sourceId": "<stateKey>"} and {"source": "constant", "sourceId": "<text>"}. For non-string constants set the typed "value" field: {"source": "constant", "sourceId": "true", "value": true}. Outputs route results: {"name": "<output name>", "target": "state", "targetId": "<stateKey>"} or {"target": "ui-element", "targetId": "<element id>"} to set an element's value.
6. Structured operation inputs use dotted names: list.append takes one input per item field named "item.<field>" (never "item.id"; the part generates ids), list.updateWhere writes fields via "set.<field>". Use the parseNumber transform on numeric fields fed from text inputs.
7. Derived values need no operation: attach a "transforms" pipeline (applied in order) to a dataBinding, e.g. filterFalsy("completed") then count for "N left" (filterFalsy counts rows that never got the flag), or sum then round then format for totals. Bindings re-resolve on every state change. Make toggled flags VISIBLE: bind the row text's "className" from the flag with a map transform, {"property": "className", "source": "item", "sourceId": "completed", "transforms": [{"type": "map", "parameters": {"mapping": {"true": "done", "false": ""}}}]}; the runtime strikes through elements classed "done".
8. Conditional rendering: "visibleWhen": {"source": "state"|"item", "sourceId", "operator": "truthy"|"falsy"|"empty"|"notEmpty"|"equals"|"notEquals"|"gt"|"gte"|"lt"|"lte", "value"?, "transforms"?}. An array of conditions means all must hold. Combine with state.set for tabs and view switching.
9. Element knobs (variant, size, role, direction, gap, align, justify, padding, label, emptyText) are declared per part below; use only listed values.
10. A remote operation is configuration of an HTTP call: "implementation": {"type": "remote", "endpoint": "https://...", "method": "GET"|"POST", "headers"?}; "{name}" placeholders in the endpoint fill from same-named inputs, other inputs become query parameters (GET) or the JSON body. Builtin operations take an exact name from the catalog and no implementation. There is no way to include code and none is needed.

${catalog}

EXAMPLE CONTRACT (expense tracker; the derived total and count need no operations, everything empty or derivable is omitted, and "expenses" needs no seed because list.append writes it):
{
  "name": "expense-tracker",
  "version": "1.0.0",
  "elements": [
    { "id": "title", "type": "text", "properties": { "content": "Expenses", "role": "title" } },
    { "id": "entry", "type": "container", "properties": { "direction": "row", "gap": "8", "align": "end" }, "children": [
      { "id": "desc-in", "type": "input", "properties": { "placeholder": "Description", "label": "What" } },
      { "id": "amt-in", "type": "input", "properties": { "placeholder": "0.00", "type": "number", "label": "Amount" } },
      { "id": "add-btn", "type": "button", "properties": { "text": "Add", "variant": "primary" }, "eventBindings": [ { "event": "click", "operationId": "op-add" } ] } ] },
    { "id": "rows", "type": "list", "properties": { "emptyText": "No expenses yet" },
      "dataBindings": [ { "property": "items", "source": "state", "sourceId": "expenses" } ],
      "children": [
        { "id": "r-desc", "type": "text", "dataBindings": [ { "property": "content", "source": "item", "sourceId": "description" } ] },
        { "id": "r-amt", "type": "text", "properties": { "role": "caption" }, "dataBindings": [ { "property": "content", "source": "item", "sourceId": "amount", "transforms": [ { "type": "round", "parameters": { "decimals": 2 } }, { "type": "format", "parameters": { "template": "$ {{value}}" } } ] } ] },
        { "id": "r-del", "type": "button", "properties": { "text": "Delete", "variant": "danger", "size": "sm" }, "eventBindings": [ { "event": "click", "operationId": "op-del" } ] } ] },
    { "id": "summary", "type": "container", "properties": { "direction": "row", "justify": "between" }, "visibleWhen": { "source": "state", "sourceId": "expenses", "operator": "notEmpty" }, "children": [
      { "id": "count", "type": "text", "properties": { "role": "caption" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "expenses", "transforms": [ { "type": "count", "parameters": {} }, { "type": "format", "parameters": { "template": "{{value}} expenses" } } ] } ] },
      { "id": "total", "type": "text", "properties": { "role": "subtitle" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "expenses", "transforms": [ { "type": "sum", "parameters": { "field": "amount" } }, { "type": "round", "parameters": { "decimals": 2 } }, { "type": "format", "parameters": { "template": "Total: $ {{value}}" } } ] } ] } ] }
  ],
  "operations": [
    { "id": "op-add", "operationName": "list.append",
      "inputs": [
        { "name": "key", "source": "constant", "sourceId": "expenses" },
        { "name": "item.description", "source": "ui-element", "sourceId": "desc-in" },
        { "name": "item.amount", "source": "ui-element", "sourceId": "amt-in", "transforms": [ { "type": "parseNumber", "parameters": {} } ] } ],
      "outputs": [
        { "name": "reset", "target": "ui-element", "targetId": "desc-in" },
        { "name": "reset", "target": "ui-element", "targetId": "amt-in" } ] },
    { "id": "op-del", "operationName": "list.removeWhere",
      "inputs": [
        { "name": "key", "source": "constant", "sourceId": "expenses" },
        { "name": "value", "source": "item", "sourceId": "id" } ] }
  ]
}

Every eventBinding.operationId must match an operation id; every part, knob value, operation, and transform must come from the catalog above. Design the smallest contract that fully satisfies the request.`;
}
