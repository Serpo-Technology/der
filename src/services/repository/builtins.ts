import type { RepositoryService } from './repository-service';
import type { UIElementManifest, OperationManifest } from '../../types/component';
import { BUILTIN_OPERATIONS } from '../operations/registry';

/**
 * Registers the built-in UI elements and operations. Operation manifests are
 * derived from the builtin registry, which is the single source of truth for
 * their behavior. Idempotent: re-registration overwrites the index entries.
 */
export async function registerBuiltins(repository: RepositoryService): Promise<void> {

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

  const operations: OperationManifest[] = Object.values(BUILTIN_OPERATIONS).map((def) => ({
    id: `op-${def.name.replace(/\./g, '-')}`,
    name: def.name,
    version: '1.0.0',
    type: 'operation',
    description: def.description,
    capabilities: ['builtin'],
    dependencies: [],
    schema: { type: 'object', properties: {} },
    inputs: def.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required ?? false,
      description: input.description
    })),
    outputs: def.outputs.map((output) => ({
      name: output.name,
      type: output.type,
      description: output.description
    })),
    executionType: 'builtin',
    implementation: { type: 'builtin' }
  }));

  for (const el of uiElements) {
    await repository.registerComponent(el);
  }
  for (const op of operations) {
    await repository.registerComponent(op);
  }
}


