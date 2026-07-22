/**
 * Best-effort parsing of a truncated JSON stream, used to preview a contract
 * while the model is still writing it. The final contract never comes from
 * here; it goes through the full schema and manifest validation.
 */

import { TRANSFORMS } from '../operations/transforms';

/**
 * Parses as much of a truncated JSON object as possible: auto-closes open
 * strings, arrays, and objects, and when the tail is unparseable (a cut
 * number, a dangling key) backs up to the previous structural boundary.
 * Returns null when nothing object-shaped can be recovered yet.
 */
export function parsePartialJson(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let source = text.slice(start);

  for (let attempts = 0; attempts < 48 && source.length > 0; attempts++) {
    const completed = completeJson(source);
    if (completed !== null) {
      try {
        return JSON.parse(completed);
      } catch {
        // fall through to back up
      }
    }
    // Back up to just before the last structural boundary and retry: this
    // drops a cut-off number, literal, or dangling key.
    const cut = Math.max(
      source.lastIndexOf(','),
      source.lastIndexOf('{', source.length - 2),
      source.lastIndexOf('[', source.length - 2)
    );
    if (cut <= 0) return null;
    source = source.slice(0, source[cut] === ',' ? cut : cut + 1);
  }
  return null;
}

/** Closes whatever is open; returns null when the tail cannot be patched. */
function completeJson(source: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }

  let candidate = source;
  if (escaped) candidate = candidate.slice(0, -1);
  if (inString) candidate += '"';
  // A dangling separator cannot precede a closer.
  candidate = candidate.replace(/,\s*$/, '');
  candidate = candidate.replace(/:\s*$/, ':null');
  return candidate + stack.reverse().join('');
}

interface StreamingElement {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  dataBindings: Array<Record<string, unknown>>;
  eventBindings: [];
  visibleWhen?: unknown;
  children?: StreamingElement[];
}

export interface StreamingContract {
  name: string;
  version: string;
  elements: StreamingElement[];
  operations: [];
  styling?: { theme?: string; accent?: string };
}

/**
 * Shapes a partial model response into an inert display-only contract: only
 * well-formed elements survive, event bindings and operations are stripped so
 * nothing half-wired can run, and transform pipelines keep known steps only.
 */
export function extractStreamingContract(raw: string): StreamingContract | null {
  const parsed = parsePartialJson(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;

  // Compose responses nest the contract; contract-only responses do not.
  const candidate = (
    parsed.contract && typeof parsed.contract === 'object' ? parsed.contract : parsed
  ) as Record<string, unknown>;
  if (!Array.isArray(candidate.elements)) return null;

  const sanitizeBinding = (binding: unknown): Record<string, unknown> | null => {
    if (!binding || typeof binding !== 'object') return null;
    const b = binding as Record<string, unknown>;
    if (
      typeof b.property !== 'string' ||
      typeof b.source !== 'string' ||
      typeof b.sourceId !== 'string'
    ) {
      return null;
    }
    const transforms = Array.isArray(b.transforms)
      ? b.transforms.filter(
          (step) =>
            step &&
            typeof step === 'object' &&
            typeof (step as { type?: unknown }).type === 'string' &&
            (step as { type: string }).type in TRANSFORMS
        )
      : undefined;
    return {
      property: b.property,
      source: b.source,
      sourceId: b.sourceId,
      ...(b.value !== undefined ? { value: b.value } : {}),
      ...(transforms && transforms.length > 0 ? { transforms } : {})
    };
  };

  const sanitizeElement = (element: unknown): StreamingElement | null => {
    if (!element || typeof element !== 'object') return null;
    const e = element as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id.length === 0) return null;
    if (typeof e.type !== 'string' || e.type.length === 0) return null;
    const children = Array.isArray(e.children)
      ? (e.children.map(sanitizeElement).filter(Boolean) as StreamingElement[])
      : undefined;
    return {
      id: e.id,
      type: e.type,
      properties:
        e.properties && typeof e.properties === 'object'
          ? (e.properties as Record<string, unknown>)
          : {},
      dataBindings: Array.isArray(e.dataBindings)
        ? (e.dataBindings.map(sanitizeBinding).filter(Boolean) as Array<Record<string, unknown>>)
        : [],
      eventBindings: [],
      ...(children && children.length > 0 ? { children } : {})
    };
  };

  const elements = candidate.elements
    .map(sanitizeElement)
    .filter(Boolean) as StreamingElement[];
  if (elements.length === 0) return null;

  const styling =
    candidate.styling && typeof candidate.styling === 'object'
      ? (candidate.styling as { theme?: string; accent?: string })
      : undefined;

  return {
    name: typeof candidate.name === 'string' && candidate.name ? candidate.name : 'new-app',
    version: '1.0.0',
    elements,
    operations: [],
    ...(styling ? { styling } : {})
  };
}
