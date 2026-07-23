/**
 * Expansion of composed UI fragments: a template subtree instantiated with
 * per-use parameters. Templates write child ids as "{{id}}-suffix" so every
 * instance stays unique; "{{param}}" placeholders substitute anywhere a
 * string appears, and a string that IS exactly one placeholder takes the
 * parameter's value with its type preserved.
 */

import type { OperationBinding, UIElement } from '../../types/contract';
import type { UiFragmentDef } from '../operations/registry';
import { getUiFragmentDef } from '../operations/registry';

const PLACEHOLDER = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

function substitute(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{([a-zA-Z0-9_-]+)\}\}$/.exec(value);
    if (exact) {
      return params[exact[1]] !== undefined ? params[exact[1]] : value;
    }
    return value.replace(PLACEHOLDER, (whole, name) =>
      params[name] !== undefined ? String(params[name]) : whole
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substitute(entry, params));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substitute(entry, params);
    }
    return out;
  }
  return value;
}

/** Templates omit empty collections; the renderer expects them present. */
function fillStructuralDefaults(element: UIElement): void {
  element.properties = element.properties ?? {};
  element.dataBindings = element.dataBindings ?? [];
  element.eventBindings = element.eventBindings ?? [];
  element.children?.forEach(fillStructuralDefaults);
}

function instanceParams(element: UIElement, def: UiFragmentDef): Record<string, unknown> {
  const params: Record<string, unknown> = { id: element.id };
  for (const param of def.params) {
    if (param.default !== undefined) params[param.name] = param.default;
  }
  for (const [key, value] of Object.entries(element.properties ?? {})) {
    if (value !== undefined) params[key] = value;
  }
  return params;
}

/** Instantiates a fragment element into its expanded subtree. */
export function expandUiFragment(element: UIElement, def: UiFragmentDef): UIElement {
  const params = instanceParams(element, def);

  const expanded = substitute(def.template, params) as unknown as UIElement;
  if (!expanded || typeof expanded !== 'object' || expanded.type === element.type) {
    throw new Error(`UI fragment "${element.type}" has an invalid template`);
  }
  fillStructuralDefaults(expanded);
  // The instance's visibility gate applies to the whole expansion.
  if (element.visibleWhen && !expanded.visibleWhen) {
    expanded.visibleWhen = element.visibleWhen;
  }
  return expanded;
}

export interface PackOperationInstance {
  /** Concrete operation binding, substituted for one pack instance. */
  operation: OperationBinding;
  instanceId: string;
  fragmentType: string;
  /** Contract path of the instance element, for error messages. */
  path: string;
}

/** A pack operation template becomes a runnable binding: placeholders
 * substituted, structure filled, and any implementation dropped (packs
 * compose the installed vocabulary by name only). */
function instantiatePackOperation(
  template: Record<string, unknown>,
  params: Record<string, unknown>
): OperationBinding {
  const substituted = substitute(template, params) as Record<string, unknown>;
  delete substituted.implementation;
  const operation = substituted as unknown as OperationBinding;
  operation.inputs = operation.inputs ?? [];
  operation.outputs = operation.outputs ?? [];
  operation.triggers = operation.triggers ?? [];
  return operation;
}

/**
 * Collects the shipped operations of every pack instance in an element tree,
 * instantiated per use. The renderer merges these into its operation lookup
 * and validation checks them like contract operations; the stored contract
 * keeps only the compact instance element.
 */
export function expandPackOperations(elements: UIElement[]): PackOperationInstance[] {
  const collected: PackOperationInstance[] = [];
  const walk = (list: UIElement[], parentPath: string) => {
    list.forEach((element, index) => {
      const path = `${parentPath}.${index}`;
      const def = getUiFragmentDef(element.type);
      if (def?.operations?.length) {
        const params = instanceParams(element, def);
        for (const template of def.operations) {
          collected.push({
            operation: instantiatePackOperation(template, params),
            instanceId: element.id,
            fragmentType: element.type,
            path,
          });
        }
      }
      if (element.children?.length) walk(element.children, `${path}.children`);
    });
  };
  walk(elements, 'elements');
  return collected;
}
