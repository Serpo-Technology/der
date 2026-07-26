/**
 * Part registry - the single source of truth for the prewritten parts a
 * contract can compose: UI element manifests (knobs, binding surfaces, howto)
 * and builtin operations. The contract prompt, the runtime, validation, and
 * the repository catalog all derive from this module. Contracts configure
 * these parts; they never carry code.
 */

import { invoke } from '@tauri-apps/api/core';
import type { KnobSpec } from '../../types/component';
import type { OperationBinding, UIElement } from '../../types/contract';

export interface OperationContext {
  getState(key: string): unknown;
  setState(key: string, value: unknown): void;
}

export type BuiltinResult = Record<string, unknown>;

export type BuiltinFn = (
  inputs: Record<string, unknown>,
  ctx: OperationContext
) => Promise<BuiltinResult> | BuiltinResult;

export interface BuiltinIoSpec {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface BuiltinOperationDef {
  name: string;
  description: string;
  inputs: BuiltinIoSpec[];
  outputs: BuiltinIoSpec[];
  /** Input-name prefixes assembled into objects, e.g. item.title -> inputs.item.title */
  structuredPrefixes?: string[];
  /** Short usage guide written for the model. */
  howto?: string;
  /** Validated usage snippet for the prompt. */
  example?: OperationBinding;
  /** Executable but omitted from the model-facing catalog. */
  hidden?: boolean;
  execute: BuiltinFn;
}

/** A UI part's declared capability surface. */
export interface ElementManifest {
  type: string;
  description: string;
  /** Validated configuration knobs; enum knobs map to styling classes. */
  knobs: KnobSpec[];
  /** Legal but unvalidated properties (className, placeholder, src...). */
  passthroughProps?: string[];
  /** Properties intended as dataBinding targets. */
  bindableProps?: string[];
  allowsChildren?: boolean;
  /** Short usage guide written for the model. */
  howto: string;
  /** Validated usage snippet for the prompt. */
  example?: UIElement;
}

/** Tolerant equality across the string boundary (typed ids vs input text). */
export function looseEquals(a: unknown, b: unknown): boolean {
  return a === b || String(a) === String(b);
}

/** Resolves a dot-path into a value; an empty path returns the value itself. */
export function getValueAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readList(ctx: OperationContext, key: unknown): Record<string, unknown>[] {
  const value = ctx.getState(String(key ?? ''));
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Groups prefixed inputs into objects: with prefixes ['item'], the resolved
 * inputs {key, 'item.title': 'x'} become {key, item: {title: 'x'}}. The field
 * name is everything after the first prefix dot (nesting is not supported).
 */
export function assembleStructured(
  raw: Record<string, unknown>,
  prefixes: string[] | undefined
): Record<string, unknown> {
  if (!prefixes || prefixes.length === 0) return raw;
  const flat: Record<string, unknown> = {};
  const groups: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(raw)) {
    const prefix = prefixes.find((p) => name.startsWith(`${p}.`));
    if (prefix) {
      // Keep unresolved fields as null: JSON drops undefined, and a part
      // diagnosing "variable x is not a number" beats "unknown name x".
      (groups[prefix] ??= {})[name.slice(prefix.length + 1)] = value === undefined ? null : value;
    } else {
      flat[name] = value;
    }
  }
  return { ...flat, ...groups };
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
}

/**
 * Operations contributed by installed signed parts. Populated by
 * FragmentsService; executed in the Rust wasm host. Same manifest shape as
 * builtins so the catalog, validation, and executor treat them uniformly.
 */
export const FRAGMENT_OPERATIONS: Record<string, BuiltinOperationDef> = {};

/** Resolves an operation part by name: builtin first, then installed parts. */
export function getOperationDef(name: string): BuiltinOperationDef | undefined {
  return BUILTIN_OPERATIONS[name] ?? FRAGMENT_OPERATIONS[name];
}

/** Test seam: harnesses stub the file dialogs; production always invokes. */
type FileOpProvider = (inputs: Record<string, unknown>) => Promise<Record<string, unknown>>;
const fileOpProviders: { pick?: FileOpProvider; read?: FileOpProvider; save?: FileOpProvider } = {};
export function setFileOpProviders(providers: {
  pick?: FileOpProvider;
  read?: FileOpProvider;
  save?: FileOpProvider;
}): void {
  fileOpProviders.pick = providers.pick;
  fileOpProviders.read = providers.read;
  fileOpProviders.save = providers.save;
}

export const BUILTIN_OPERATIONS: Record<string, BuiltinOperationDef> = {
  'state.set': {
    name: 'state.set',
    description: 'Writes a value to a state key.',
    inputs: [
      { name: 'key', type: 'string', required: true, description: 'State key to write' },
      { name: 'value', type: 'any', required: true, description: 'Value to store' },
    ],
    outputs: [{ name: 'value', type: 'any', description: 'The stored value' }],
    howto:
      'Use for toggles and view switching: bind "key" and "value" as constants (use the typed "value" field for booleans and numbers), then show panels with visibleWhen equals on that key.',
    example: {
      id: 'op-show-done',
      operationName: 'state.set',
      executionType: 'builtin',
      inputs: [
        { name: 'key', source: 'constant', sourceId: 'view' },
        { name: 'value', source: 'constant', sourceId: 'done', value: 'done' },
      ],
      outputs: [],
      triggers: [],
    },
    execute: (inputs, ctx) => {
      const key = String(inputs.key ?? '');
      ctx.setState(key, inputs.value);
      return { value: inputs.value };
    },
  },
  'counter.add': {
    name: 'counter.add',
    description: 'Adds an amount (default 1) to a numeric state key.',
    inputs: [
      { name: 'key', type: 'string', required: true, description: 'State key holding the number' },
      { name: 'amount', type: 'number', required: false, description: 'Amount to add (default 1)' },
    ],
    outputs: [{ name: 'value', type: 'number', description: 'The new value' }],
    howto: 'Seed the key in initialState. Negative amounts subtract.',
    execute: (inputs, ctx) => {
      const key = String(inputs.key ?? '');
      const current = Number(ctx.getState(key)) || 0;
      const amount = inputs.amount === undefined ? 1 : Number(inputs.amount) || 0;
      const next = current + amount;
      ctx.setState(key, next);
      return { value: next };
    },
  },
  'list.append': {
    name: 'list.append',
    description:
      'Appends an item to an array state key. Item fields come from inputs named item.<field>; the part generates the id itself.',
    inputs: [
      { name: 'key', type: 'string', required: true, description: 'State key of the array' },
      {
        name: 'item.<field>',
        type: 'any',
        required: true,
        description: 'One input per item field, e.g. item.title, item.amount',
      },
    ],
    outputs: [
      { name: 'list', type: 'array', description: 'The updated array' },
      { name: 'item', type: 'object', description: 'The created item, or null when all fields were empty' },
      { name: 'reset', type: 'string', description: "Always ''; route to entry inputs to clear them" },
    ],
    structuredPrefixes: ['item'],
    howto:
      'Never supply item.id; it is generated. Skips silently when every item field is blank. Use the parseNumber transform on numeric fields fed from text inputs.',
    example: {
      id: 'op-add',
      operationName: 'list.append',
      executionType: 'builtin',
      inputs: [
        { name: 'key', source: 'constant', sourceId: 'expenses' },
        { name: 'item.description', source: 'ui-element', sourceId: 'desc-in' },
        {
          name: 'item.amount',
          source: 'ui-element',
          sourceId: 'amount-in',
          transforms: [{ type: 'parseNumber', parameters: {} }],
        },
      ],
      outputs: [
        { name: 'reset', target: 'ui-element', targetId: 'desc-in' },
        { name: 'reset', target: 'ui-element', targetId: 'amount-in' },
      ],
      triggers: [],
    },
    execute: (inputs, ctx) => {
      const key = String(inputs.key ?? '');
      const list = readList(ctx, key);
      const fields =
        inputs.item && typeof inputs.item === 'object'
          ? { ...(inputs.item as Record<string, unknown>) }
          : {};
      const meaningful = Object.entries(fields).filter(([name]) => name !== 'id');
      if (meaningful.length === 0 || meaningful.every(([, value]) => isBlank(value))) {
        return { list, item: null, reset: '' };
      }
      const item = { ...fields, id: newId() };
      const next = [...list, item];
      ctx.setState(key, next);
      return { list: next, item, reset: '' };
    },
  },
  'list.updateWhere': {
    name: 'list.updateWhere',
    description:
      'Updates matching items in an array state key. Fields to write come from inputs named set.<field>.',
    inputs: [
      { name: 'key', type: 'string', required: true, description: 'State key of the array' },
      { name: 'field', type: 'string', required: false, description: "Match field (default 'id')" },
      { name: 'value', type: 'any', required: true, description: 'Value the match field must equal' },
      { name: 'set.<field>', type: 'any', required: true, description: 'One input per field to write' },
    ],
    outputs: [
      { name: 'list', type: 'array', description: 'The updated array' },
      { name: 'count', type: 'number', description: 'How many items matched' },
    ],
    structuredPrefixes: ['set'],
    howto: "Typical row edit: value from {source: 'item', sourceId: 'id'}.",
    execute: (inputs, ctx) => {
      const key = String(inputs.key ?? '');
      const field = isBlank(inputs.field) ? 'id' : String(inputs.field);
      const updates =
        inputs.set && typeof inputs.set === 'object'
          ? (inputs.set as Record<string, unknown>)
          : {};
      let count = 0;
      const next = readList(ctx, key).map((item) => {
        if (looseEquals(getValueAtPath(item, field), inputs.value)) {
          count++;
          return { ...item, ...updates };
        }
        return item;
      });
      ctx.setState(key, next);
      return { list: next, count };
    },
  },
  'list.removeWhere': {
    name: 'list.removeWhere',
    description: 'Removes matching items from an array state key.',
    inputs: [
      { name: 'key', type: 'string', required: true, description: 'State key of the array' },
      { name: 'field', type: 'string', required: false, description: "Match field (default 'id')" },
      { name: 'value', type: 'any', required: true, description: 'Value the match field must equal' },
    ],
    outputs: [{ name: 'list', type: 'array', description: 'The updated array' }],
    howto: "Typical row delete: value from {source: 'item', sourceId: 'id'}.",
    example: {
      id: 'op-delete',
      operationName: 'list.removeWhere',
      executionType: 'builtin',
      inputs: [
        { name: 'key', source: 'constant', sourceId: 'expenses' },
        { name: 'value', source: 'item', sourceId: 'id' },
      ],
      outputs: [],
      triggers: [],
    },
    execute: (inputs, ctx) => {
      const key = String(inputs.key ?? '');
      const field = isBlank(inputs.field) ? 'id' : String(inputs.field);
      const next = readList(ctx, key).filter(
        (item) => !looseEquals(getValueAtPath(item, field), inputs.value)
      );
      ctx.setState(key, next);
      return { list: next };
    },
  },
  'list.toggleField': {
    name: 'list.toggleField',
    description: 'Flips a boolean field on the matching item of an array state key.',
    inputs: [
      { name: 'key', type: 'string', required: true, description: 'State key of the array' },
      { name: 'id', type: 'any', required: true, description: 'Id of the item to toggle' },
      { name: 'field', type: 'string', required: false, description: "Boolean field (default 'completed')" },
    ],
    outputs: [{ name: 'list', type: 'array', description: 'The updated array' }],
    howto: "Typical row toggle: id from {source: 'item', sourceId: 'id'}. Show the flag: bind the row text's className from it (map {'true': 'done'}) and count remaining rows with filterFalsy.",
    execute: (inputs, ctx) => {
      const key = String(inputs.key ?? '');
      const field = isBlank(inputs.field) ? 'completed' : String(inputs.field);
      const next = readList(ctx, key).map((item) =>
        looseEquals(getValueAtPath(item, 'id'), inputs.id)
          ? { ...item, [field]: !item[field] }
          : item
      );
      ctx.setState(key, next);
      return { list: next };
    },
  },
  'math.add': {
    name: 'math.add',
    description: 'Adds two numbers. Returns {result}. Route the result with an OutputBinding.',
    inputs: [
      { name: 'a', type: 'number', required: true },
      { name: 'b', type: 'number', required: true },
    ],
    outputs: [{ name: 'result', type: 'number' }],
    howto: 'Pure calculation; write the result to state with an OutputBinding when it should display.',
    execute: (inputs) => ({ result: (Number(inputs.a) || 0) + (Number(inputs.b) || 0) }),
  },
  'time.now': {
    name: 'time.now',
    description: 'The current date and time. Route the outputs you need into state.',
    inputs: [],
    outputs: [
      { name: 'iso', type: 'string', description: 'Full ISO timestamp' },
      { name: 'date', type: 'string', description: 'Local date as YYYY-MM-DD' },
      { name: 'time', type: 'string', description: 'Local time as HH:MM' },
      { name: 'epoch', type: 'number', description: 'Milliseconds since 1970' },
    ],
    howto:
      'To stamp new list entries, run this FIRST on the same click (bindings run in order): first binding writes date to a state key, the second binding is the list.append whose "item.date" input reads that key {source: "state", sourceId: "<key>"}. Display stamps with the formatDate transform.',
    execute: () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return {
        iso: now.toISOString(),
        date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
        epoch: now.getTime(),
      };
    },
  },
  'random.int': {
    name: 'random.int',
    description: 'A uniform random whole number between min and max, both included.',
    inputs: [
      { name: 'min', type: 'number', required: true, description: 'Lowest possible value' },
      { name: 'max', type: 'number', required: true, description: 'Highest possible value' },
    ],
    outputs: [{ name: 'value', type: 'number', description: 'The rolled number' }],
    howto:
      'Dice and roll patterns: bind min and max as typed constants, run on a click, route value into a state key shown by a text element. Numeric strings coerce.',
    example: {
      id: 'op-roll',
      operationName: 'random.int',
      executionType: 'builtin',
      inputs: [
        { name: 'min', source: 'constant', sourceId: '1', value: 1 },
        { name: 'max', source: 'constant', sourceId: '6', value: 6 },
      ],
      outputs: [{ name: 'value', target: 'state', targetId: 'roll' }],
      triggers: [],
    },
    execute: (inputs) => {
      const min = Number(inputs.min);
      const max = Number(inputs.max);
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        throw new Error('random.int needs numeric min and max');
      }
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return { value: lo + Math.floor(Math.random() * (hi - lo + 1)) };
    },
  },
  'random.pick': {
    name: 'random.pick',
    description: 'Picks one entry of an array at random.',
    inputs: [
      { name: 'list', type: 'array', required: true, description: 'Entries to choose from' },
    ],
    outputs: [
      { name: 'value', type: 'any', description: 'The chosen entry' },
      { name: 'index', type: 'number', description: 'Its position in the array' },
    ],
    howto:
      'Random picker pattern: collect options with list.append, bind list from that state key, run on a click, and route value into a state key. When entries are objects from list.append, show a field by adding a pick transform on the value output, e.g. transforms [{"type": "pick", "parameters": {"field": "title"}}].',
    example: {
      id: 'op-pick',
      operationName: 'random.pick',
      executionType: 'builtin',
      inputs: [{ name: 'list', source: 'state', sourceId: 'options' }],
      outputs: [
        {
          name: 'value',
          target: 'state',
          targetId: 'chosen',
          transforms: [{ type: 'pick', parameters: { field: 'title' } }],
        },
      ],
      triggers: [],
    },
    execute: (inputs) => {
      const list = Array.isArray(inputs.list) ? inputs.list : [];
      if (list.length === 0) {
        throw new Error('The list is empty; add entries before picking');
      }
      const index = Math.floor(Math.random() * list.length);
      return { value: list[index], index };
    },
  },
  'http.get': {
    name: 'http.get',
    description:
      'Fetches JSON from an http(s) URL. Returns {response}. Route the response with an OutputBinding into state.',
    inputs: [{ name: 'url', type: 'string', required: true, description: 'http(s) URL' }],
    outputs: [{ name: 'response', type: 'object' }],
    howto:
      'Fetching real remote data ONLY; never for math on existing state (use expr.evaluate, stats, or transforms for that). A computed URL is a url input bound from an element or state with a format transform, e.g. transforms [{"type": "format", "parameters": {"template": "https://host/search?q={{value}}"}}]. Route the response into a state key and display it with pick/format.',
    execute: async (inputs) => {
      const url = String(inputs.url ?? '');
      if (!/^https?:\/\//.test(url)) {
        throw new Error(`http.get needs an http(s) URL, got: ${url || '(empty)'}`);
      }
      const result = await invoke<{ success: boolean; data?: unknown; error?: string }>(
        'execute_operation',
        {
          request: {
            operation_id: 'http.get',
            operation_name: 'http.get',
            operation_type: 'remote',
            inputs: {},
            implementation: { type: 'remote', endpoint: url, method: 'GET', headers: {} },
          },
        }
      );
      if (!result.success) {
        throw new Error(result.error ?? 'HTTP GET failed');
      }
      return { response: result.data };
    },
  },

  'file.pick': {
    name: 'file.pick',
    description:
      'Opens the system file picker. Returns {file, url, name, size, mime}: "file" is a token file.read consumes; "url" is what pdf, video, and image elements bind their src to.',
    inputs: [
      {
        name: 'kind',
        type: 'string',
        required: false,
        description: 'Filter: pdf | image | video | markdown | text; omit for any file',
      },
    ],
    outputs: [
      { name: 'file', type: 'string', description: 'Grant token for file.read' },
      { name: 'url', type: 'string', description: 'Renderer URL for viewer src bindings' },
      { name: 'name', type: 'string' },
      { name: 'size', type: 'number' },
      { name: 'mime', type: 'string' },
    ],
    howto:
      'Wire it to an Open button, route "url" into state for a viewer\'s src binding and "name" into state for a caption. Route "file" into state only when a converter needs the bytes via file.read. Cancelling the dialog stops the chain.',
    execute: async (inputs) => {
      const provider = fileOpProviders.pick;
      if (provider) return provider(inputs);
      return await invoke('file_pick', { kind: String(inputs.kind ?? '') || undefined });
    },
  },
  'file.read': {
    name: 'file.read',
    description:
      'Reads a picked file as base64. Input "file" is file.pick\'s token; returns {base64, name, mime, size} for compute parts to consume.',
    inputs: [
      { name: 'file', type: 'string', required: true, description: "file.pick's \"file\" output" },
    ],
    outputs: [
      { name: 'base64', type: 'string' },
      { name: 'text', type: 'string', description: 'UTF-8 content for text files; null for binary' },
      { name: 'name', type: 'string' },
      { name: 'mime', type: 'string' },
      { name: 'size', type: 'number' },
    ],
    howto:
      'Chain on the same click after file.pick: pick routes "file" into state, file.read takes it from state and routes "base64" (binary parts) or "text" (markdown and text parts) into state for the converter step. Only user-picked files are readable.',
    execute: async (inputs) => {
      const provider = fileOpProviders.read;
      if (provider) return provider(inputs);
      return await invoke('file_read', { file: String(inputs.file ?? '') });
    },
  },
  'file.save': {
    name: 'file.save',
    description:
      'Saves base64 data through the system save panel. Inputs: data (base64), name (suggested filename). Returns {saved, name}.',
    inputs: [
      { name: 'data', type: 'string', required: true, description: 'Base64 bytes to write' },
      { name: 'name', type: 'string', required: false, description: 'Suggested filename' },
    ],
    outputs: [
      { name: 'saved', type: 'boolean' },
      { name: 'name', type: 'string' },
    ],
    howto:
      'The last step of a converter chain: feed it the converter\'s base64 output from state and suggest a filename with the right extension. The user picks where it lands; cancelling stops the chain.',
    execute: async (inputs) => {
      const provider = fileOpProviders.save;
      if (provider) return provider(inputs);
      return await invoke('file_save', {
        data: String(inputs.data ?? ''),
        name: String(inputs.name ?? '') || undefined,
      });
    },
  },

  // Compat parts for previously saved contracts; hidden from the catalog.
  'todos.add': {
    name: 'todos.add',
    description: "Appends a todo {id, title, completed:false} to the 'todos' state array.",
    inputs: [{ name: 'title', type: 'string', required: true, description: 'Todo text' }],
    outputs: [
      { name: 'todos', type: 'array', description: 'The updated todos array' },
      { name: 'todo', type: 'object', description: 'The created todo, or null for empty input' },
      { name: 'reset', type: 'string', description: "Always ''; use to clear the entry input" },
    ],
    hidden: true,
    execute: (inputs, ctx) => {
      const title = String(inputs.title ?? '').trim();
      const todos = readList(ctx, 'todos') as unknown as TodoItem[];
      if (!title) {
        return { todos, todo: null, reset: '' };
      }
      const todo: TodoItem = { id: newId(), title, completed: false };
      const next = [...todos, todo];
      ctx.setState('todos', next);
      return { todos: next, todo, reset: '' };
    },
  },
  'todos.toggle': {
    name: 'todos.toggle',
    description: "Flips 'completed' on the todo with the given id in the 'todos' state array.",
    inputs: [{ name: 'id', type: 'string', required: true, description: 'Todo id' }],
    outputs: [{ name: 'todos', type: 'array', description: 'The updated todos array' }],
    hidden: true,
    execute: (inputs, ctx) => {
      const next = (readList(ctx, 'todos') as unknown as TodoItem[]).map((todo) =>
        looseEquals(todo.id, inputs.id) ? { ...todo, completed: !todo.completed } : todo
      );
      ctx.setState('todos', next);
      return { todos: next };
    },
  },
  'todos.remove': {
    name: 'todos.remove',
    description: "Removes the todo with the given id from the 'todos' state array.",
    inputs: [{ name: 'id', type: 'string', required: true, description: 'Todo id' }],
    outputs: [{ name: 'todos', type: 'array', description: 'The updated todos array' }],
    hidden: true,
    execute: (inputs, ctx) => {
      const next = (readList(ctx, 'todos') as unknown as TodoItem[]).filter(
        (todo) => !looseEquals(todo.id, inputs.id)
      );
      ctx.setState('todos', next);
      return { todos: next };
    },
  },
};

const SPACING_VALUES = ['0', '4', '8', '12', '16', '24'];

export const ELEMENT_MANIFESTS: Record<string, ElementManifest> = {
  text: {
    type: 'text',
    description: 'Text content.',
    knobs: [
      {
        name: 'role',
        type: 'enum',
        values: ['title', 'subtitle', 'body', 'caption', 'label'],
        default: 'body',
        description: 'Typographic role',
      },
      {
        name: 'tone',
        type: 'enum',
        values: ['default', 'muted', 'accent', 'danger'],
        default: 'default',
        description:
          "Text color from the theme: 'muted' for secondary lines, 'accent' to highlight a value in the app accent, 'danger' for warnings",
      },
    ],
    passthroughProps: ['content', 'className'],
    bindableProps: ['content'],
    howto:
      'Bind "content" from state or item; use transform pipelines for derived text (filterBy then count, sum then round then format).',
    example: {
      id: 'items-left',
      type: 'text',
      properties: { role: 'caption' },
      dataBindings: [
        {
          property: 'content',
          source: 'state',
          sourceId: 'todos',
          transforms: [
            { type: 'filterBy', parameters: { field: 'completed', value: 'false' } },
            { type: 'count', parameters: {} },
            { type: 'format', parameters: { template: '{{value}} items left' } },
          ],
        },
      ],
      eventBindings: [],
    },
  },
  button: {
    type: 'button',
    description: 'Clickable button.',
    knobs: [
      {
        name: 'variant',
        type: 'enum',
        values: ['default', 'primary', 'danger', 'ghost'],
        default: 'default',
        description: 'Visual emphasis',
      },
      {
        name: 'size',
        type: 'enum',
        values: ['sm', 'md', 'lg'],
        default: 'md',
        description: 'Button size',
      },
    ],
    passthroughProps: ['text', 'disabled', 'className'],
    howto: 'Label via the "text" property; wire clicks with eventBindings. One primary button per view.',
  },
  input: {
    type: 'input',
    description: 'Text input, auto-controlled by the runtime.',
    knobs: [
      { name: 'label', type: 'string', description: 'Optional label rendered above the field' },
    ],
    passthroughProps: ['placeholder', 'type', 'className'],
    howto:
      'Give it an id and NEVER bind its value; operations read it with an InputBinding {source: "ui-element", sourceId: "<id>"}. For dates use properties {"type": "date"}: the value is YYYY-MM-DD and ISO dates sort and compare correctly as strings. Not allowed inside list children.',
  },
  textarea: {
    type: 'textarea',
    description: 'Multi-line text input, auto-controlled by the runtime.',
    knobs: [
      { name: 'label', type: 'string', description: 'Optional label rendered above the field' },
      { name: 'rows', type: 'number', default: 4, description: 'Visible text rows' },
    ],
    passthroughProps: ['placeholder', 'className'],
    howto:
      'Notes, descriptions, anything multi-line; same rules as input: give it an id, never bind its value, read it with {source: "ui-element", sourceId: "<id>"}. Not allowed inside list children.',
  },
  timer: {
    type: 'timer',
    description: 'Invisible interval clock: fires its "tick" event while rendered.',
    knobs: [
      { name: 'seconds', type: 'number', default: 1, description: 'Seconds between ticks' },
    ],
    passthroughProps: [],
    howto:
      'Renders nothing. Wire eventBindings [{"event": "tick", "operationId": "<op id>"}] to run an operation on every tick, e.g. counter.add on an "elapsed" key. Gate it with visibleWhen on a state flag and flip the flag with Start/Stop buttons (state.set): a hidden timer does not tick.',
  },
  container: {
    type: 'container',
    description: 'Layout container for children.',
    knobs: [
      { name: 'direction', type: 'enum', values: ['row', 'column'], default: 'row', description: 'Flex direction' },
      { name: 'gap', type: 'enum', values: SPACING_VALUES, default: '8', description: 'Gap between children (px)' },
      {
        name: 'align',
        type: 'enum',
        values: ['start', 'center', 'end', 'stretch'],
        default: 'center',
        description:
          "Cross-axis alignment. Rows that pair labeled inputs with buttons need 'end' so the buttons sit level with the input boxes; 'center' floats them against the taller labeled field.",
      },
      {
        name: 'justify',
        type: 'enum',
        values: ['start', 'center', 'end', 'between'],
        default: 'start',
        description: 'Main-axis distribution',
      },
      { name: 'padding', type: 'enum', values: SPACING_VALUES, default: '0', description: 'Inner padding (px)' },
      {
        name: 'surface',
        type: 'enum',
        values: ['plain', 'card', 'accent'],
        default: 'plain',
        description:
          "Panel look: 'card' raises the group on the theme's surface with a border, 'accent' tints it with the app accent. Use them to give sections and summaries visible structure",
      },
    ],
    passthroughProps: ['className'],
    allowsChildren: true,
    howto: 'Group related elements; use direction "column" for stacked sections and "row" for toolbars.',
  },
  list: {
    type: 'list',
    description: 'Repeats its children once per entry of the bound "items" array.',
    knobs: [
      { name: 'emptyText', type: 'string', description: 'Text shown when the array is empty' },
    ],
    passthroughProps: ['className'],
    bindableProps: ['items'],
    allowsChildren: true,
    howto:
      'Bind "items" from state (filterBy/sortBy pipelines allowed). Children are the row template; read entry fields with source "item". No input elements inside.',
  },
  form: {
    type: 'form',
    description: 'Form wrapper; submit events get preventDefault.',
    knobs: [],
    passthroughProps: ['className'],
    allowsChildren: true,
    howto: 'Wrap an entry row to make Enter submit; wire {"event": "submit"} to the same operation as the button.',
  },
  image: {
    type: 'image',
    description: 'Image.',
    knobs: [],
    passthroughProps: ['src', 'alt', 'className'],
    bindableProps: ['src'],
    howto: 'Set "src" and "alt".',
  },
  chart: {
    type: 'chart',
    description: 'Bar or line chart over an array of objects.',
    knobs: [
      {
        name: 'kind',
        type: 'enum',
        values: ['bar', 'line'],
        default: 'bar',
        description: 'Chart form',
      },
    ],
    passthroughProps: ['data', 'x', 'y', 'emptyText', 'className'],
    bindableProps: ['data'],
    howto:
      'Bind "data" from a state array; "x" names the label field and "y" the numeric field (defaults "key" and "sum", exactly what groupSum emits). Category totals: transforms [{"type": "groupSum", "parameters": {"by": "category", "field": "amount"}}] on the data binding. Per-row computed values chain deriveField first.',
  },
  pdf: {
    type: 'pdf',
    description: 'PDF viewer: renders the document its "src" points at.',
    knobs: [],
    passthroughProps: ['src', 'emptyText', 'className'],
    bindableProps: ['src'],
    howto:
      'Bind "src" from state fed by file.pick\'s "url" output (an Open button chains file.pick and routes url into state). Set "emptyText" for the before-open message.',
  },
  video: {
    type: 'video',
    description: 'Video player with controls for the file its "src" points at.',
    knobs: [],
    passthroughProps: ['src', 'emptyText', 'className'],
    bindableProps: ['src'],
    howto:
      'Bind "src" from state fed by file.pick\'s "url" output, exactly like the pdf element.',
  },
  link: {
    type: 'link',
    description: 'Hyperlink.',
    knobs: [],
    passthroughProps: ['href', 'text', 'className'],
    howto: 'Set "href" and "text".',
  },
  select: {
    type: 'select',
    description: 'Dropdown, auto-controlled by the runtime.',
    knobs: [
      { name: 'label', type: 'string', description: 'Optional label rendered above the field' },
      { name: 'placeholder', type: 'string', description: 'Shown while nothing is selected' },
    ],
    passthroughProps: ['className'],
    bindableProps: ['options'],
    howto:
      'Fixed choices go in properties as a REAL array: "properties": {"options": [{"value": "food", "label": "Food"}, ...]} (a bare ["a","b"] also works). Only bind options when they come from state. Operations read the selection via {source: "ui-element", sourceId: "<id>"}.',
  },
  checkbox: {
    type: 'checkbox',
    description: 'Checkbox.',
    knobs: [{ name: 'label', type: 'string', description: 'Text rendered beside the box' }],
    passthroughProps: ['className'],
    bindableProps: ['checked'],
    howto:
      'Standalone: auto-controlled, read via {source: "ui-element"}. Inside list rows: bind "checked" from {source: "item"} and wire {"event": "change"} to list.toggleField.',
  },
  progress: {
    type: 'progress',
    description: 'Progress bar.',
    knobs: [{ name: 'max', type: 'number', default: 100, description: 'Value at 100%' }],
    passthroughProps: ['className'],
    bindableProps: ['value'],
    howto: 'Bind "value" from state (sum/count pipelines work well).',
  },
  divider: {
    type: 'divider',
    description: 'Horizontal separator.',
    knobs: [],
    passthroughProps: ['className'],
    howto: 'Use between sections.',
  },
};

/**
 * Legacy prompt-catalog view kept for compatibility; prefer ELEMENT_MANIFESTS.
 */
export const ELEMENT_CATALOG: Record<string, { description: string; properties: string[] }> =
  Object.fromEntries(
    Object.values(ELEMENT_MANIFESTS).map((manifest) => [
      manifest.type,
      {
        description: manifest.description,
        properties: [
          ...manifest.knobs.map((knob) => knob.name),
          ...(manifest.passthroughProps ?? []),
        ],
      },
    ])
  );

/** Plain HTML tags the renderer also accepts as element types. */
/** Installed composed UI fragments, keyed by their namespaced name; the
 * renderer expands instances and the catalog lists them. */
export interface UiFragmentParam {
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface UiFragmentDef {
  name: string;
  description: string;
  howto?: string;
  params: UiFragmentParam[];
  template: Record<string, unknown>;
  /** Present on partial-experience packs: operation templates instantiated
   * per use with the same {{id}} scoping as template ids, so the pattern
   * works with no outer wiring. */
  operations?: Array<Record<string, unknown>>;
}

export const FRAGMENT_ELEMENTS: Record<string, UiFragmentDef> = {};

export function getUiFragmentDef(type: string): UiFragmentDef | undefined {
  return FRAGMENT_ELEMENTS[type];
}

/** Installed recipes: full experiences shipped by signed parts as declarative
 * contracts, instantiated as ready apps instead of generated. */
export interface RecipeDef {
  name: string;
  title: string;
  description: string;
  keywords: string[];
  /** Spec header captured when the contract was proven. */
  spec?: { goal?: string; assumptions?: string[]; openQuestions?: string[] };
  /** The contract in the model's output vocabulary, validated against the
   * installed part manifests before instantiation. */
  contract: Record<string, unknown>;
  partId: string;
  publisher: string;
}

export const FRAGMENT_RECIPES: Record<string, RecipeDef> = {};

export function getRecipeDef(name: string): RecipeDef | undefined {
  return FRAGMENT_RECIPES[name];
}

export function listRecipeDefs(): RecipeDef[] {
  return Object.values(FRAGMENT_RECIPES);
}

/** Redacted integration credentials (names and shapes, never secrets):
 * remote operations reference one via implementation.auth. */
export interface IntegrationCredentialView {
  name: string;
  kind: string;
  target?: string;
  baseUrl?: string;
  notes?: string;
}

export const INTEGRATION_CREDENTIALS: IntegrationCredentialView[] = [];

export function setIntegrationCredentials(views: IntegrationCredentialView[]): void {
  INTEGRATION_CREDENTIALS.length = 0;
  INTEGRATION_CREDENTIALS.push(...views);
}

/** App-level looks a contract can pick via styling.theme / styling.accent. */
export const STYLE_THEMES = ['default', 'dark', 'paper', 'terminal'] as const;
export const STYLE_ACCENTS = ['blue', 'green', 'violet', 'rose', 'amber', 'cyan'] as const;

export const INTRINSIC_ELEMENT_TYPES = new Set([
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'section',
  'header',
  'footer',
  'label',
  'strong',
  'em',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
]);

export function isKnownElementType(type: string): boolean {
  return type in ELEMENT_MANIFESTS || INTRINSIC_ELEMENT_TYPES.has(type) || type in FRAGMENT_ELEMENTS;
}
