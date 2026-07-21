import type { RepositoryService } from './repository-service';
import type { UIElementManifest, OperationManifest } from '../../types/component';

/**
 * Registers a minimal set of built-in UI elements and operations
 * sufficient to compose example prompts and enable LLM-guided construction.
 */
export async function registerBuiltins(repository: RepositoryService): Promise<void> {
  const existing = await repository.listComponents();
  if (existing.length > 0) return;

  const uiElements: UIElementManifest[] = [
    {
      id: 'ui-button',
      name: 'button',
      version: '1.0.0',
      type: 'ui-element',
      description: 'Clickable button element',
      capabilities: ['clickable', 'styled'],
      dependencies: [],
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Button label', default: 'Button' },
          disabled: { type: 'boolean', description: 'Disable button', default: false }
        }
      },
      styleSchema: { type: 'object', properties: {} },
      inputs: [
        { name: 'text', type: 'string', required: false, description: 'Label text' }
      ],
      outputs: [
        { name: 'onClick', type: 'event', description: 'Click event' }
      ],
      renderFunction: 'button'
    },
    {
      id: 'ui-input',
      name: 'input',
      version: '1.0.0',
      type: 'ui-element',
      description: 'Text input element',
      capabilities: ['input', 'styled'],
      dependencies: [],
      schema: {
        type: 'object',
        properties: {
          placeholder: { type: 'string', description: 'Placeholder text' },
          value: { type: 'string', description: 'Value' }
        }
      },
      styleSchema: { type: 'object', properties: {} },
      inputs: [
        { name: 'value', type: 'string', required: false },
        { name: 'placeholder', type: 'string', required: false }
      ],
      outputs: [
        { name: 'onChange', type: 'event', description: 'Change event' }
      ],
      renderFunction: 'input'
    },
    {
      id: 'ui-text',
      name: 'text',
      version: '1.0.0',
      type: 'ui-element',
      description: 'Inline text element',
      capabilities: ['display', 'styled'],
      dependencies: [],
      schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Text content', default: '' }
        }
      },
      styleSchema: { type: 'object', properties: {} },
      inputs: [
        { name: 'content', type: 'string', required: false }
      ],
      outputs: [],
      renderFunction: 'span'
    },
    {
      id: 'ui-container',
      name: 'container',
      version: '1.0.0',
      type: 'ui-element',
      description: 'Generic container',
      capabilities: ['layout', 'styled'],
      dependencies: [],
      schema: { type: 'object', properties: {} },
      styleSchema: { type: 'object', properties: {} },
      inputs: [],
      outputs: [],
      renderFunction: 'div'
    },
    {
      id: 'ui-list',
      name: 'list',
      version: '1.0.0',
      type: 'ui-element',
      description: 'List element',
      capabilities: ['display', 'styled'],
      dependencies: [],
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', description: 'Items to render' }
        }
      },
      styleSchema: { type: 'object', properties: {} },
      inputs: [ { name: 'items', type: 'array', required: false } ],
      outputs: [],
      renderFunction: 'ul'
    }
  ];

  const operations: OperationManifest[] = [
    {
      id: 'op-math-add',
      name: 'math.add',
      version: '1.0.0',
      type: 'operation',
      description: 'Adds two numbers',
      capabilities: ['math'],
      dependencies: [],
      schema: { type: 'object', properties: {} },
      inputs: [
        { name: 'a', type: 'number', required: true },
        { name: 'b', type: 'number', required: true }
      ],
      outputs: [ { name: 'result', type: 'number' } ],
      executionType: 'local',
      implementation: { type: 'local', code: 'const { a, b } = inputs; return { result: Number(a) + Number(b) };' }
    },
    {
      id: 'op-http-get',
      name: 'http.get',
      version: '1.0.0',
      type: 'operation',
      description: 'Performs an HTTP GET request',
      capabilities: ['http', 'remote'],
      dependencies: [],
      schema: { type: 'object', properties: {} },
      inputs: [ { name: 'url', type: 'string', required: true } ],
      outputs: [ { name: 'response', type: 'object' } ],
      executionType: 'remote',
      implementation: { type: 'remote', endpoint: 'https://example.com/api/proxy', method: 'POST', headers: { 'Content-Type': 'application/json' } }
    },
    {
      id: 'op-todos-add',
      name: 'todos.add',
      version: '1.0.0',
      type: 'operation',
      description: 'Adds a todo item',
      capabilities: ['local'],
      dependencies: [],
      schema: { type: 'object', properties: {} },
      inputs: [ { name: 'title', type: 'string', required: true } ],
      outputs: [ { name: 'todo', type: 'object' } ],
      executionType: 'local',
      implementation: { type: 'local', code: 'return { todo: { id: Date.now(), title: inputs.title, completed: false } };' }
    },
    {
      id: 'op-todos-toggle',
      name: 'todos.toggle',
      version: '1.0.0',
      type: 'operation',
      description: 'Toggles a todo',
      capabilities: ['local'],
      dependencies: [],
      schema: { type: 'object', properties: {} },
      inputs: [ { name: 'id', type: 'number', required: true }, { name: 'completed', type: 'boolean', required: true } ],
      outputs: [ { name: 'todo', type: 'object' } ],
      executionType: 'local',
      implementation: { type: 'local', code: 'return { todo: { id: inputs.id, completed: !!inputs.completed } };' }
    }
  ];

  for (const el of uiElements) {
    await repository.registerComponent(el);
  }
  for (const op of operations) {
    await repository.registerComponent(op);
  }
}


