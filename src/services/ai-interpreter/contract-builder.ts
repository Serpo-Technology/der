/**
 * Contract Builder - generates a runnable Contract from a Blueprint with the
 * LLM, constrained by the component catalog and validated against the
 * contract schema (with one repair round).
 */

import { Blueprint } from '../../types/blueprint';
import { Contract, OperationBinding, UIElement, ValidationResult } from '../../types/contract';
import { ComponentRepository } from '../../types/repository';
import { LLMClient, LLMMessage } from './llm-client';
import { generateValidatedJson } from './llm-json';
import { ContractSchema, normalizeContract, validateContractObject } from '../../schemas/contract';
import {
  BUILTIN_OPERATIONS,
  ELEMENT_CATALOG,
  INTRINSIC_ELEMENT_TYPES,
  isKnownElementType,
} from '../operations/registry';

type ContractShape = typeof ContractSchema._output;

export class ContractBuilder {
  constructor(
    private repository: ComponentRepository,
    private llmClient: LLMClient = new LLMClient()
  ) {}

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

    const shape = await generateValidatedJson(this.llmClient, messages, ContractSchema, {
      label: 'Contract',
      maxTokens: 16000,
    });

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
    const elementLines = Object.entries(ELEMENT_CATALOG).map(
      ([type, spec]) =>
        `- ${type}: ${spec.description}${
          spec.properties.length ? ` Properties: ${spec.properties.join(', ')}.` : ''
        }`
    );

    const operationLines = Object.values(BUILTIN_OPERATIONS).map((def) => {
      const inputs = def.inputs.map((i) => `${i.name}: ${i.type}`).join(', ') || 'none';
      const outputs = def.outputs.map((o) => `${o.name}: ${o.type}`).join(', ') || 'none';
      return `- ${def.name} (inputs: ${inputs}; outputs: ${outputs}): ${def.description}`;
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
      'ELEMENT TYPES (use these; plain HTML tag names are also accepted):',
      ...elementLines,
      '',
      'BUILTIN OPERATIONS (use the exact name with executionType "builtin"):',
      ...operationLines,
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

    // Resolve each operation to a runnable execution type or drop it.
    const dropped = new Set<string>();
    const operations: OperationBinding[] = [];
    for (const op of shape.operations as OperationBinding[]) {
      const id = uniqueId(op.id);
      if (BUILTIN_OPERATIONS[op.operationName]) {
        operations.push({ ...op, id, executionType: 'builtin', implementation: undefined });
      } else if (op.implementation?.code) {
        operations.push({
          ...op,
          id,
          executionType: 'local',
          implementation: { ...op.implementation, type: 'local' },
        });
      } else if (op.implementation?.endpoint) {
        operations.push({
          ...op,
          id,
          executionType: 'remote',
          implementation: { ...op.implementation, type: 'remote' },
        });
      } else {
        dropped.add(op.id);
        warnings.push(
          `Dropped operation "${op.operationName}" (${op.id}): not a builtin and no implementation given`
        );
      }
    }

    // Strip event bindings that point at dropped operations.
    const stripDropped = (element: UIElement): UIElement => ({
      ...element,
      eventBindings: element.eventBindings.filter((b) => !dropped.has(b.operationId)),
      children: element.children?.map(stripDropped),
    });

    const now = new Date();
    const contract: Contract = {
      name: shape.name,
      version: shape.version,
      initialState: shape.initialState,
      elements: dropped.size ? elements.map(stripDropped) : elements,
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
  return `You generate a Contract JSON that a runtime renders into a live interactive app. Return one JSON object only: no prose, no code fences.

CONTRACT SHAPE:
{
  "name": "kebab-case-name",
  "version": "1.0.0",
  "initialState": { "stateKey": <seed value> },
  "elements": [ { "id", "type", "properties": {}, "dataBindings": [], "eventBindings": [], "children": [...] } ],
  "operations": [ { "id", "operationName", "executionType", "inputs": [], "outputs": [], "triggers": [] } ],
  "layout": { "type": "flex", "properties": { "flexDirection": "column", "gap": "12px", "padding": "16px" } },
  "styling": { "theme": "default" }
}
Do not include a "metadata" field; it is added automatically. "triggers" must always be [].

RUNTIME RULES (follow exactly):
1. State is a flat map. Operations write it; display elements read it with dataBindings {"property", "source": "state", "sourceId": "<stateKey>"}. Seed every state key you read in "initialState".
2. Inputs are auto-controlled. Give each input an id; NEVER bind its value. Operations read an input's current text with an InputBinding {"name": "<param>", "source": "ui-element", "sourceId": "<input element id>"}.
3. Wire interactions only with eventBindings on elements: {"event": "click" | "change" | "submit", "operationId": "<operation id>"}.
4. A "list" element repeats its children once per entry of the array bound to its "items" property. Inside those children, read fields of the current entry with source "item" and a dot-path sourceId (e.g. "title"; "" for the whole entry), including operation InputBindings {"source": "item", "sourceId": "id"}. Do not place "input" elements inside list children.
5. Operation inputs may also use {"source": "state", "sourceId": "<stateKey>"} or {"source": "constant", "sourceId": "<literal string>"}. Outputs route results: {"name": "<output name>", "target": "state", "targetId": "<stateKey>"} or {"target": "ui-element", "targetId": "<element id>"} to set an element's value.
6. executionType "builtin": use an exact builtin operation name from the catalog. Builtin todos.* operations manage the "todos" state array themselves.
7. executionType "local": custom logic; set "implementation": {"type": "local", "code": "<JavaScript function body receiving (inputs, ctx), returning an object keyed by output names; ctx.getState(key)/ctx.setState(key, value) access state>"}.
8. executionType "remote": HTTP call; set "implementation": {"type": "remote", "endpoint": "https://...", "method": "GET"|"POST", "headers": {}}. "{name}" placeholders in the endpoint are filled from same-named inputs; other inputs become query parameters (GET) or the JSON body.

${catalog}

EXAMPLE (todo app with add and toggle):
{
  "name": "todo-list",
  "version": "1.0.0",
  "initialState": { "todos": [] },
  "elements": [
    { "id": "title", "type": "text", "properties": { "content": "My Todos" }, "dataBindings": [], "eventBindings": [] },
    { "id": "todo-input", "type": "input", "properties": { "placeholder": "What needs doing?" }, "dataBindings": [], "eventBindings": [] },
    { "id": "add-btn", "type": "button", "properties": { "text": "Add" }, "dataBindings": [], "eventBindings": [ { "event": "click", "operationId": "op-add" } ] },
    { "id": "todo-list", "type": "list", "properties": {},
      "dataBindings": [ { "property": "items", "source": "state", "sourceId": "todos" } ],
      "eventBindings": [],
      "children": [
        { "id": "row", "type": "container", "properties": {}, "dataBindings": [], "eventBindings": [], "children": [
          { "id": "row-title", "type": "text", "properties": {}, "dataBindings": [ { "property": "content", "source": "item", "sourceId": "title" } ], "eventBindings": [] },
          { "id": "row-toggle", "type": "button", "properties": { "text": "Done" }, "dataBindings": [], "eventBindings": [ { "event": "click", "operationId": "op-toggle" } ] }
        ] }
      ] }
  ],
  "operations": [
    { "id": "op-add", "operationName": "todos.add", "executionType": "builtin",
      "inputs": [ { "name": "title", "source": "ui-element", "sourceId": "todo-input" } ],
      "outputs": [ { "name": "reset", "target": "ui-element", "targetId": "todo-input" } ], "triggers": [] },
    { "id": "op-toggle", "operationName": "todos.toggle", "executionType": "builtin",
      "inputs": [ { "name": "id", "source": "item", "sourceId": "id" } ], "outputs": [], "triggers": [] }
  ],
  "layout": { "type": "flex", "properties": { "flexDirection": "column", "gap": "12px", "padding": "16px" } },
  "styling": { "theme": "default" }
}

Design the smallest contract that fully satisfies the blueprint. Every eventBinding.operationId must match an operation id. Every state key read by a dataBinding must be seeded in initialState or written by an operation output or builtin.`;
}
