/**
 * Shared transform registry - the prewritten value transformations contracts
 * can compose. Used by the renderer, the executor, the contract prompt
 * catalog, and validation. Every transform is data-driven configuration;
 * contracts never carry code.
 */

import type { TransformFunction } from '../../types/contract';
import type { KnobSpec } from '../../types/component';
import { getValueAtPath, looseEquals } from './registry';
import { parseRowExpression } from './row-expression';

export { looseEquals };

/** Resolves dynamic parameter references against live state. */
export interface TransformContext {
  lookup?: (source: 'state' | 'element', sourceId: string) => unknown;
}

/** A parameter value of the shape {"source": "state"|"element", "sourceId"}. */
function isParamRef(value: unknown): value is { source: 'state' | 'element'; sourceId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  if (keys.length !== 2 || !keys.includes('source') || !keys.includes('sourceId')) return false;
  const ref = value as { source?: unknown; sourceId?: unknown };
  // "ui-element" is the operation-input spelling of the same thing.
  return (
    (ref.source === 'state' || ref.source === 'element' || ref.source === 'ui-element') &&
    typeof ref.sourceId === 'string'
  );
}

/** Replaces parameter references with live values; static parameters pass through. */
export function resolveTransformParameters(
  parameters: Record<string, unknown>,
  context?: TransformContext
): Record<string, unknown> {
  let resolved: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(parameters)) {
    if (isParamRef(value)) {
      resolved = resolved ?? { ...parameters };
      resolved[key] = context?.lookup ? context.lookup(value.source, value.sourceId) : undefined;
    }
  }
  return resolved ?? parameters;
}

export interface TransformDef {
  name: string;
  description: string;
  parameters: KnobSpec[];
  /** What the transform yields: display pipelines must end in a scalar. */
  output: 'array' | 'scalar' | 'any';
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
    output: 'scalar',
    description: 'Number of entries in an array (0 for anything else).',
    parameters: [],
    apply: (value) => asArray(value).length,
  },
  sum: {
    name: 'sum',
    output: 'scalar',
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
    output: 'array',
    description:
      'Keeps array entries whose field equals the given value; an empty value keeps everything, so an "All" dropdown option can use value "".',
    parameters: [
      { name: 'field', type: 'string', description: 'Field to compare' },
      { name: 'value', type: 'string', description: 'Value to match' },
    ],
    apply: (value, parameters) => {
      const wanted = parameters.value;
      if (wanted === '' || wanted === null || wanted === undefined) return asArray(value);
      return asArray(value).filter((item) => looseEquals(fieldOf(item, parameters.field), wanted));
    },
  },
  filterContains: {
    name: 'filterContains',
    output: 'array',
    description:
      'Keeps array entries whose field contains the given text, case-insensitive; empty text keeps everything. Bind value dynamically for live search.',
    parameters: [
      { name: 'field', type: 'string', description: 'Field to search' },
      { name: 'value', type: 'string', description: 'Text to look for' },
    ],
    apply: (value, parameters) => {
      const needle = String(parameters.value ?? '').toLowerCase();
      if (!needle) return asArray(value);
      return asArray(value).filter((item) =>
        String(fieldOf(item, parameters.field) ?? '')
          .toLowerCase()
          .includes(needle)
      );
    },
  },
  filterTruthy: {
    name: 'filterTruthy',
    output: 'array',
    description: 'Keeps array entries whose field is truthy (set flags, checked rows).',
    parameters: [{ name: 'field', type: 'string', description: 'Field to test' }],
    apply: (value, parameters) =>
      asArray(value).filter((item) => Boolean(fieldOf(item, parameters.field))),
  },
  filterFalsy: {
    name: 'filterFalsy',
    output: 'array',
    description:
      'Keeps array entries whose field is falsy or missing (e.g. not-completed rows; a row that never got the flag counts).',
    parameters: [{ name: 'field', type: 'string', description: 'Field to test' }],
    apply: (value, parameters) =>
      asArray(value).filter((item) => !fieldOf(item, parameters.field)),
  },
  sortBy: {
    name: 'sortBy',
    output: 'array',
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
  deriveField: {
    name: 'deriveField',
    output: 'array',
    description:
      'Adds a computed field to every row of an array: an arithmetic expression over that row\'s numeric fields (e.g. field "value", expression "qty * price"). Rows keep their other fields; read the new field like any row field, sum it for totals, or sortBy it.',
    parameters: [
      { name: 'field', type: 'string', description: 'Name of the field to add' },
      {
        name: 'expression',
        type: 'string',
        description:
          'Arithmetic over row fields: + - * / % ^, parentheses, sqrt/abs/floor/ceil/round, min/max/pow, pi, e',
      },
    ],
    apply: (value, parameters) => {
      const field = String(parameters.field ?? '');
      const source = String(parameters.expression ?? '');
      if (!field || !source) return asArray(value);
      let parsed;
      try {
        parsed = parseRowExpression(source);
      } catch {
        // Validation rejects bad expressions before a contract renders;
        // anything that still arrives here degrades to untouched rows.
        return asArray(value);
      }
      return asArray(value).map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const row = item as Record<string, unknown>;
        let result: number | null;
        try {
          result = parsed.evaluate(row);
        } catch {
          // One bad row (a missing or non-numeric field) shows an empty
          // cell instead of poisoning the whole list.
          result = null;
        }
        return { ...row, [field]: result };
      });
    },
  },
  pick: {
    name: 'pick',
    output: 'any',
    description:
      'Reads a field (dot path allowed) from an object; an array reads from its first entry, so filterBy then pick gives the matched entry\'s field.',
    parameters: [{ name: 'field', type: 'string', description: 'Field to read' }],
    apply: (value, parameters) =>
      fieldOf(Array.isArray(value) ? value[0] : value, parameters.field),
  },
  pluck: {
    name: 'pluck',
    output: 'array',
    description:
      'Field values across an array of objects (turns [{value: 5}, ...] into [5, ...]; use before count/sum or numeric part inputs).',
    parameters: [{ name: 'field', type: 'string', description: 'Field to project' }],
    apply: (value, parameters) => asArray(value).map((item) => fieldOf(item, parameters.field)),
  },
  equals: {
    name: 'equals',
    output: 'scalar',
    description: 'True when the value equals the given value.',
    parameters: [{ name: 'value', type: 'string', description: 'Value to compare' }],
    apply: (value, parameters) => looseEquals(value, parameters.value),
  },
  not: {
    name: 'not',
    output: 'scalar',
    description: 'Boolean negation of the value.',
    parameters: [],
    apply: (value) => !value,
  },
  parseNumber: {
    name: 'parseNumber',
    output: 'scalar',
    description: 'Converts input text to a number (0 when not numeric).',
    parameters: [],
    apply: (value) => Number(value) || 0,
  },
  round: {
    name: 'round',
    output: 'scalar',
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
    output: 'scalar',
    description:
      'Inserts the value into a template at {{value}}; every other {{name}} slot fills from a same-named parameter (parameters may be live references).',
    parameters: [
      { name: 'template', type: 'string', description: 'Template containing {{value}} and optional {{name}} slots' },
    ],
    apply: (value, parameters) => {
      const template = parameters.template;
      if (typeof template !== 'string') return value;
      let out = template.replace(
        '{{value}}',
        value === null || value === undefined ? '' : String(value)
      );
      // Named slots: {{ssid}} fills from parameters.ssid, already resolved
      // when it was a live reference.
      out = out.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (whole, name: string) => {
        if (name === 'value') return whole;
        const slot = parameters[name];
        if (slot === undefined) return whole;
        return slot === null ? '' : String(slot);
      });
      return out;
    },
  },
  formatNumber: {
    name: 'formatNumber',
    output: 'scalar',
    description:
      'Formats a number with thousands separators and fixed decimals, optional prefix/suffix (e.g. "$ ", " EUR").',
    parameters: [
      { name: 'decimals', type: 'number', default: 2, description: 'Decimal places' },
      { name: 'prefix', type: 'string', default: '', description: 'Text before the number' },
      { name: 'suffix', type: 'string', default: '', description: 'Text after the number' },
    ],
    apply: (value, parameters) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      const decimals = Math.max(0, Math.min(8, Number(parameters.decimals ?? 2) || 0));
      const formatted = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(n);
      return `${parameters.prefix ?? ''}${formatted}${parameters.suffix ?? ''}`;
    },
  },
  formatDate: {
    name: 'formatDate',
    output: 'scalar',
    description:
      "Formats a date (ISO string or epoch milliseconds) for display; style date|time|datetime|weekday.",
    parameters: [
      {
        name: 'style',
        type: 'enum',
        values: ['date', 'time', 'datetime', 'weekday'],
        default: 'date',
        description: 'What to show',
      },
    ],
    apply: (value, parameters) => {
      if (value === null || value === undefined || value === '') return '';
      const date = new Date(value as string | number);
      if (Number.isNaN(date.getTime())) return value;
      const style = String(parameters.style ?? 'date');
      const options: Intl.DateTimeFormatOptions =
        style === 'time'
          ? { hour: '2-digit', minute: '2-digit' }
          : style === 'datetime'
            ? { dateStyle: 'medium', timeStyle: 'short' }
            : style === 'weekday'
              ? { weekday: 'long' }
              : { dateStyle: 'medium' };
      try {
        return new Intl.DateTimeFormat(undefined, options).format(date);
      } catch {
        return String(value);
      }
    },
  },
  map: {
    name: 'map',
    output: 'any',
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

function applyOne(value: unknown, transform: TransformFunction, context?: TransformContext): unknown {
  const def = TRANSFORMS[transform.type];
  if (!def) {
    console.warn(`Unknown transform "${transform.type}" skipped`);
    return value;
  }
  return def.apply(value, resolveTransformParameters(transform.parameters ?? {}, context));
}

/**
 * Applies a binding's transforms. The legacy singular `transform` keeps its
 * skip-on-null behavior; a `transforms` pipeline runs every step null-safely
 * so aggregations like count(undefined) produce 0.
 */
export function applyBindingTransforms(
  value: unknown,
  binding: { transform?: TransformFunction; transforms?: TransformFunction[] },
  context?: TransformContext
): unknown {
  if (binding.transforms && binding.transforms.length > 0) {
    return binding.transforms.reduce((current, step) => applyOne(current, step, context), value);
  }
  if (binding.transform) {
    if (value === null || value === undefined) return value;
    return applyOne(value, binding.transform, context);
  }
  return value;
}

/** Applies an explicit pipeline (used by visibleWhen conditions). */
export function applyTransformPipeline(
  value: unknown,
  transforms?: TransformFunction[],
  context?: TransformContext
): unknown {
  if (!transforms || transforms.length === 0) return value;
  return transforms.reduce((current, step) => applyOne(current, step, context), value);
}
