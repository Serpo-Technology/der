/**
 * Shared transform registry - the prewritten value transformations contracts
 * can compose. Used by the renderer, the executor, the contract prompt
 * catalog, and validation. Every transform is data-driven configuration;
 * contracts never carry code.
 */

import type { TransformFunction } from '../../types/contract';
import type { KnobSpec } from '../../types/component';
import { getValueAtPath, looseEquals } from './registry';

export { looseEquals };

export interface TransformDef {
  name: string;
  description: string;
  parameters: KnobSpec[];
  /** Null-safe: called even when value is null/undefined. */
  apply(value: unknown, parameters: Record<string, any>): unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fieldOf(item: unknown, field: unknown): unknown {
  if (field === undefined || field === null || field === '') return item;
  return getValueAtPath(item, String(field));
}

export const TRANSFORMS: Record<string, TransformDef> = {
  count: {
    name: 'count',
    description: 'Number of entries in an array (0 for anything else).',
    parameters: [],
    apply: (value) => asArray(value).length,
  },
  sum: {
    name: 'sum',
    description: 'Sum of a numeric field across an array of objects.',
    parameters: [
      { name: 'field', type: 'string', description: 'Field to sum', default: '' },
    ],
    apply: (value, parameters) =>
      asArray(value).reduce<number>(
        (total, item) => total + (Number(fieldOf(item, parameters.field)) || 0),
        0
      ),
  },
  filterBy: {
    name: 'filterBy',
    description: 'Keeps array entries whose field equals the given value.',
    parameters: [
      { name: 'field', type: 'string', description: 'Field to compare' },
      { name: 'value', type: 'string', description: 'Value to match' },
    ],
    apply: (value, parameters) =>
      asArray(value).filter((item) => looseEquals(fieldOf(item, parameters.field), parameters.value)),
  },
  sortBy: {
    name: 'sortBy',
    description: 'Sorts an array by a field; numeric when both values are numbers.',
    parameters: [
      { name: 'field', type: 'string', description: 'Field to sort by' },
      {
        name: 'direction',
        type: 'enum',
        values: ['asc', 'desc'],
        default: 'asc',
        description: 'Sort direction',
      },
    ],
    apply: (value, parameters) => {
      // Copy first: the bound value is often the state array itself.
      const copy = [...asArray(value)];
      const direction = parameters.direction === 'desc' ? -1 : 1;
      copy.sort((a, b) => {
        const av = fieldOf(a, parameters.field);
        const bv = fieldOf(b, parameters.field);
        const an = Number(av);
        const bn = Number(bv);
        if (Number.isFinite(an) && Number.isFinite(bn)) {
          return (an - bn) * direction;
        }
        return String(av ?? '').localeCompare(String(bv ?? '')) * direction;
      });
      return copy;
    },
  },
  pick: {
    name: 'pick',
    description: 'Reads a field (dot path allowed) from a single object.',
    parameters: [{ name: 'field', type: 'string', description: 'Field to read' }],
    apply: (value, parameters) => fieldOf(value, parameters.field),
  },
  pluck: {
    name: 'pluck',
    description:
      'Field values across an array of objects (turns [{value: 5}, ...] into [5, ...]; use before count/sum or numeric part inputs).',
    parameters: [{ name: 'field', type: 'string', description: 'Field to project' }],
    apply: (value, parameters) => asArray(value).map((item) => fieldOf(item, parameters.field)),
  },
  equals: {
    name: 'equals',
    description: 'True when the value equals the given value.',
    parameters: [{ name: 'value', type: 'string', description: 'Value to compare' }],
    apply: (value, parameters) => looseEquals(value, parameters.value),
  },
  not: {
    name: 'not',
    description: 'Boolean negation of the value.',
    parameters: [],
    apply: (value) => !value,
  },
  parseNumber: {
    name: 'parseNumber',
    description: 'Converts input text to a number (0 when not numeric).',
    parameters: [],
    apply: (value) => Number(value) || 0,
  },
  round: {
    name: 'round',
    description: 'Rounds a number to the given decimals.',
    parameters: [
      { name: 'decimals', type: 'number', default: 0, description: 'Decimal places' },
    ],
    apply: (value, parameters) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      const decimals = Number(parameters.decimals) || 0;
      const factor = Math.pow(10, decimals);
      const rounded = Math.round(n * factor) / factor;
      return decimals > 0 ? rounded.toFixed(decimals) : rounded;
    },
  },
  format: {
    name: 'format',
    description: 'Inserts the value into a template at {{value}}.',
    parameters: [
      { name: 'template', type: 'string', description: 'Template containing {{value}}' },
    ],
    apply: (value, parameters) => {
      const template = parameters.template;
      if (typeof template !== 'string') return value;
      return template.replace('{{value}}', value === null || value === undefined ? '' : String(value));
    },
  },
  map: {
    name: 'map',
    description: 'Maps the value through a lookup table (mapping[String(value)]).',
    parameters: [
      { name: 'mapping', type: 'string', description: 'Object of value -> replacement' },
    ],
    apply: (value, parameters) => {
      const mapping = parameters.mapping;
      if (mapping && typeof mapping === 'object') {
        return (mapping as Record<string, unknown>)[String(value)] ?? value;
      }
      return value;
    },
  },
};

function applyOne(value: unknown, transform: TransformFunction): unknown {
  const def = TRANSFORMS[transform.type];
  if (!def) {
    console.warn(`Unknown transform "${transform.type}" skipped`);
    return value;
  }
  return def.apply(value, transform.parameters ?? {});
}

/**
 * Applies a binding's transforms. The legacy singular `transform` keeps its
 * skip-on-null behavior; a `transforms` pipeline runs every step null-safely
 * so aggregations like count(undefined) produce 0.
 */
export function applyBindingTransforms(
  value: unknown,
  binding: { transform?: TransformFunction; transforms?: TransformFunction[] }
): unknown {
  if (binding.transforms && binding.transforms.length > 0) {
    return binding.transforms.reduce((current, step) => applyOne(current, step), value);
  }
  if (binding.transform) {
    if (value === null || value === undefined) return value;
    return applyOne(value, binding.transform);
  }
  return value;
}

/** Applies an explicit pipeline (used by visibleWhen conditions). */
export function applyTransformPipeline(value: unknown, transforms?: TransformFunction[]): unknown {
  if (!transforms || transforms.length === 0) return value;
  return transforms.reduce((current, step) => applyOne(current, step), value);
}
