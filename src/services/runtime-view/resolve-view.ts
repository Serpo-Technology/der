/**
 * The pure view resolver: contract elements plus current state become a
 * resolved tree with visibility applied, data bindings computed, list rows
 * expanded with their item scopes, control values read, and event tables in
 * contract order. The webview renderer consumes this tree and adds
 * presentation (React components, knob classes, handler wiring); a native
 * renderer consumes the same shape over the core boundary. The Rust twin in
 * src-tauri/src/runtime/view.rs is held identical by the view vectors.
 */

import type { DataBinding, UIElement, VisibilityCondition } from '../../types/contract';
import { getUiFragmentDef, getValueAtPath, looseEquals } from '../operations/registry';
import { expandUiFragment } from '../fragments/ui-fragments';
import { applyBindingTransforms, applyTransformPipeline } from '../operations/transforms';

const INPUT_LIKE_TYPES = new Set(['input', 'textarea', 'select', 'checkbox']);

export interface ItemScope {
  item: unknown;
  index: number;
}

export interface ResolvedControl {
  kind: 'checkbox' | 'value';
  value: unknown;
}

export interface ResolvedRow {
  key: string;
  item: unknown;
  children: ResolvedNode[];
}

export interface ResolvedNode {
  id: string;
  type: string;
  /** Static properties merged with resolved bindings; bindings win. */
  props: Record<string, unknown>;
  /** Contract event name -> operation ids, in contract order. */
  events: Record<string, string[]>;
  /** The list item echoed back as event context for nodes inside a row. */
  eventItem?: unknown;
  /** Auto-controlled value for input-like elements outside list rows. */
  control?: ResolvedControl;
  children: ResolvedNode[];
  /** list elements with a template: resolved rows. */
  rows?: ResolvedRow[];
}

export interface ViewState {
  data: Record<string, unknown>;
}

/** Resolves a subtree; invisible elements are omitted entirely. */
export function resolveViewTree(
  elements: UIElement[],
  state: ViewState,
  scope?: ItemScope
): ResolvedNode[] {
  const resolved: ResolvedNode[] = [];
  for (const element of elements) {
    const node = resolveElement(element, state, scope);
    if (node) resolved.push(node);
  }
  return resolved;
}

function resolveElement(
  element: UIElement,
  state: ViewState,
  scope?: ItemScope
): ResolvedNode | null {
  if (!isVisible(element, state, scope)) return null;

  // Installed composed UI fragments expand into their template subtree; the
  // expansion resolves like authored elements.
  const fragmentDef = getUiFragmentDef(element.type);
  if (fragmentDef) {
    try {
      return resolveElement(expandUiFragment(element, fragmentDef), state, scope);
    } catch {
      return null;
    }
  }

  const props: Record<string, unknown> = { ...(element.properties ?? {}) };
  for (const binding of element.dataBindings ?? []) {
    props[binding.property] = resolveDataBinding(binding, state, scope);
  }

  const events: Record<string, string[]> = {};
  for (const binding of element.eventBindings ?? []) {
    (events[binding.event] ??= []).push(binding.operationId);
  }

  const node: ResolvedNode = {
    id: element.id,
    type: element.type,
    props,
    events,
    children: [],
  };
  if (scope) node.eventItem = scope.item;

  if (INPUT_LIKE_TYPES.has(element.type) && !scope) {
    const stateValue = state.data[`element_${element.id}`];
    const isCheckbox = element.type === 'checkbox' || props.type === 'checkbox';
    node.control = isCheckbox
      ? { kind: 'checkbox', value: Boolean(stateValue) }
      : { kind: 'value', value: stateValue ?? element.properties?.defaultValue ?? '' };
  }

  if (element.type === 'list' && element.children && element.children.length > 0) {
    const items = props.items;
    const array: unknown[] = Array.isArray(items) ? items : [];
    node.rows = array.map((item, index) => {
      const record = item as Record<string, unknown> | null;
      const key =
        record && typeof record === 'object' && record.id !== undefined
          ? String(record.id)
          : String(index);
      return {
        key,
        item,
        children: resolveViewTree(element.children!, state, { item, index }),
      };
    });
    return node;
  }

  node.children = resolveViewTree(element.children ?? [], state, scope);
  return node;
}

function resolveDataBinding(binding: DataBinding, state: ViewState, scope?: ItemScope): unknown {
  let value: unknown;
  switch (binding.source) {
    case 'state':
      value = state.data[binding.sourceId];
      break;
    case 'operation':
      value = state.data[`operation_${binding.sourceId}`];
      break;
    case 'constant':
      value = binding.value !== undefined ? binding.value : binding.sourceId;
      break;
    case 'item':
      value = getValueAtPath(scope?.item, binding.sourceId);
      break;
    default:
      value = null;
  }
  return applyBindingTransforms(value, binding, {
    lookup: (source, sourceId) =>
      state.data[source === 'element' ? `element_${sourceId}` : sourceId],
  });
}

export function isVisible(element: UIElement, state: ViewState, scope?: ItemScope): boolean {
  const raw = element.visibleWhen;
  if (!raw) return true;
  const conditions = Array.isArray(raw) ? raw : [raw];
  return conditions.every((condition) => evaluateCondition(condition, state, scope));
}

/**
 * A condition's comparison value may be a literal or a reference object in
 * the transform-parameter grammar ({"source": "state"|"element"|"constant"});
 * models write both, so both resolve.
 */
function resolveConditionValue(raw: unknown, state: ViewState): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const ref = raw as { source?: unknown; sourceId?: unknown; value?: unknown };
  if (typeof ref.source !== 'string') return raw;
  switch (ref.source) {
    case 'state':
      return state.data[String(ref.sourceId ?? '')];
    case 'element':
      return state.data[`element_${String(ref.sourceId ?? '')}`];
    case 'constant':
      return ref.value !== undefined ? ref.value : ref.sourceId;
    default:
      return raw;
  }
}

function evaluateCondition(
  condition: VisibilityCondition,
  state: ViewState,
  scope?: ItemScope
): boolean {
  const read =
    condition.source === 'state'
      ? state.data[condition.sourceId]
      : getValueAtPath(scope?.item, condition.sourceId);
  const value = applyTransformPipeline(read, condition.transforms, {
    lookup: (source, sourceId) =>
      state.data[source === 'element' ? `element_${sourceId}` : sourceId],
  });
  const against = resolveConditionValue(condition.value, state);

  switch (condition.operator) {
    case 'truthy':
      return Boolean(value);
    case 'falsy':
      return !value;
    case 'empty':
      return Array.isArray(value)
        ? value.length === 0
        : value === null || value === undefined || String(value) === '';
    case 'notEmpty':
      return Array.isArray(value)
        ? value.length > 0
        : !(value === null || value === undefined || String(value) === '');
    case 'equals':
      return looseEquals(value, against);
    case 'notEquals':
      return !looseEquals(value, against);
    case 'gt':
      return Number(value) > Number(against);
    case 'gte':
      return Number(value) >= Number(against);
    case 'lt':
      return Number(value) < Number(against);
    case 'lte':
      return Number(value) <= Number(against);
    default:
      return true;
  }
}
