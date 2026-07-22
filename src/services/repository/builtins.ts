import type { RepositoryService } from './repository-service';
import type { UIElementManifest, OperationManifest } from '../../types/component';
import { BUILTIN_OPERATIONS, ELEMENT_MANIFESTS } from '../operations/registry';

/**
 * Registers the built-in UI elements and operations. Operation manifests are
 * derived from the builtin registry, which is the single source of truth for
 * their behavior. Idempotent: re-registration overwrites the index entries.
 */
export async function registerBuiltins(repository: RepositoryService): Promise<void> {

  const uiElements: UIElementManifest[] = Object.values(ELEMENT_MANIFESTS).map((manifest) => ({
    id: `ui-${manifest.type}`,
    name: manifest.type,
    version: '1.0.0',
    type: 'ui-element',
    description: manifest.description,
    capabilities: ['builtin'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: Object.fromEntries(
        manifest.knobs.map((knob) => [
          knob.name,
          {
            type: knob.type === 'enum' ? 'string' : knob.type,
            description: knob.description,
            enum: knob.values,
            default: knob.default
          }
        ])
      )
    },
    styleSchema: { type: 'object', properties: {} },
    inputs: (manifest.bindableProps ?? []).map((prop) => ({
      name: prop,
      type: 'any',
      required: false
    })),
    outputs: [],
    renderFunction: manifest.type
  }));

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


