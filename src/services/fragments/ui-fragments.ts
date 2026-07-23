/**
 * Expansion of composed UI fragments: a template subtree instantiated with
 * per-use parameters. Templates write child ids as "{{id}}-suffix" so every
 * instance stays unique; "{{param}}" placeholders substitute anywhere a
 * string appears, and a string that IS exactly one placeholder takes the
 * parameter's value with its type preserved.
 */

import type { UIElement } from '../../types/contract';
import type { UiFragmentDef } from '../operations/registry';

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

/** Instantiates a fragment element into its expanded subtree. */
export function expandUiFragment(element: UIElement, def: UiFragmentDef): UIElement {
  const params: Record<string, unknown> = { id: element.id };
  for (const param of def.params) {
    if (param.default !== undefined) params[param.name] = param.default;
  }
  for (const [key, value] of Object.entries(element.properties ?? {})) {
    if (value !== undefined) params[key] = value;
  }

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
