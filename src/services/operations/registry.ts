/**
 * Builtin operation registry - real TypeScript implementations of the
 * operations that generated contracts can bind to, plus the element catalog
 * both the contract generator prompt and the runtime share.
 */

import { invoke } from '@tauri-apps/api/core';

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
  execute: BuiltinFn;
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
}

function readTodos(ctx: OperationContext): TodoItem[] {
  const value = ctx.getState('todos');
  return Array.isArray(value) ? (value as TodoItem[]) : [];
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const BUILTIN_OPERATIONS: Record<string, BuiltinOperationDef> = {
  'todos.add': {
    name: 'todos.add',
    description:
      "Appends a todo {id, title, completed:false} to the 'todos' state array. Ignores empty titles. Returns {todos, todo, reset:''} - bind the 'reset' output to the entry input (target 'ui-element') to clear it.",
    inputs: [{ name: 'title', type: 'string', required: true, description: 'Todo text' }],
    outputs: [
      { name: 'todos', type: 'array', description: 'The updated todos array' },
      { name: 'todo', type: 'object', description: 'The created todo, or null for empty input' },
      { name: 'reset', type: 'string', description: "Always ''; use to clear the entry input" },
    ],
    execute: (inputs, ctx) => {
      const title = String(inputs.title ?? '').trim();
      const todos = readTodos(ctx);
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
    execute: (inputs, ctx) => {
      const id = String(inputs.id ?? '');
      const next = readTodos(ctx).map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
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
    execute: (inputs, ctx) => {
      const id = String(inputs.id ?? '');
      const next = readTodos(ctx).filter((todo) => todo.id !== id);
      ctx.setState('todos', next);
      return { todos: next };
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
    execute: (inputs) => ({ result: Number(inputs.a) + Number(inputs.b) }),
  },
  'http.get': {
    name: 'http.get',
    description:
      'Fetches JSON from an http(s) URL. Returns {response}. Route the response with an OutputBinding into state.',
    inputs: [{ name: 'url', type: 'string', required: true, description: 'http(s) URL' }],
    outputs: [{ name: 'response', type: 'object' }],
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
};

/**
 * Element types the runtime renders natively, with the properties the
 * generator may set. Anything else falls back to a plain container.
 */
export const ELEMENT_CATALOG: Record<string, { description: string; properties: string[] }> = {
  text: { description: 'Text content', properties: ['content'] },
  button: { description: 'Clickable button', properties: ['text', 'disabled'] },
  input: {
    description:
      'Text input. Auto-controlled by the runtime: never bind its own value; operations read it via an InputBinding {source:"ui-element", sourceId:"<element id>"}.',
    properties: ['placeholder', 'defaultValue', 'type'],
  },
  container: { description: 'Layout container for children', properties: [] },
  list: {
    description:
      'Repeats its children once per item of the array bound to the "items" property. Inside the children, use bindings with source "item".',
    properties: ['items (bind via dataBindings)'],
  },
  form: { description: 'Form wrapper; submit events get preventDefault', properties: [] },
  image: { description: 'Image', properties: ['src', 'alt'] },
  link: { description: 'Hyperlink', properties: ['href', 'text'] },
};

/** Plain HTML tags the renderer also accepts as element types. */
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
  return type in ELEMENT_CATALOG || INTRINSIC_ELEMENT_TYPES.has(type);
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
