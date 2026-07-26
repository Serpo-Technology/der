/**
 * The resolved-view protocol types: what the runtime core's resolver emits
 * and every renderer consumes. Resolution itself lives in the kernel
 * (der-runtime's view module); this file keeps only the shapes.
 */

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
