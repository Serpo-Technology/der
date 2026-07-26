/**
 * Component Renderer - Renders individual UI elements from contracts.
 *
 * Conventions the renderer implements:
 * - input-like elements are auto-controlled: their value lives in state under
 *   `element_${id}` and every change writes it back (skipped inside list
 *   templates, where one key would be shared across rows);
 * - a `list` element with children repeats them per entry of its bound
 *   `items` array, exposing the entry to bindings with source 'item';
 * - `visibleWhen` conditions gate rendering declaratively;
 * - manifest knobs map to `type-knob-value` classes; invalid enum values
 *   normalize to the manifest default;
 * - event bindings call operations with the current item as event context.
 */

import React from 'react';
import { UIElement } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { ELEMENT_MANIFESTS } from '../../services/operations/registry';
import {
  ResolvedNode,
  resolveViewTree,
} from '../../services/runtime-view/resolve-view';
import { sanitizeHtml } from '../../services/runtime-view/sanitize-html';
import type { ItemScope } from '../../services/runtime-view/resolve-view';
import type { EventContext } from './OperationExecutor';

export type { ItemScope } from '../../services/runtime-view/resolve-view';

// Standard UI component registry
const UI_COMPONENTS = {
  'button': ButtonComponent,
  'input': InputComponent,
  'textarea': TextareaComponent,
  'timer': TimerComponent,
  'text': TextComponent,
  'container': ContainerComponent,
  'list': ListComponent,
  'form': FormComponent,
  'image': ImageComponent,
  'chart': ChartComponent,
  'pdf': PdfComponent,
  'html': HtmlComponent,
  'document': DocumentComponent,
  'video': VideoComponent,
  'link': LinkComponent,
  'select': SelectComponent,
  'checkbox': CheckboxComponent,
  'progress': ProgressComponent,
  'divider': DividerComponent
};

// Supported intrinsic HTML tags for 1:1 contract rendering
const INTRINSIC_TAGS = new Set([
  'div','span','p','button','input','form','ul','ol','li','img','a','label','section','header','footer','main','nav','article','aside','h1','h2','h3','h4','h5','h6','textarea','select','option'
]);

export interface RenderOptions {
  /** Writes an element's current value into state (`element_${id}`). */
  setElementValue?: (elementId: string, value: unknown) => void;
  /** The list-item scope this element renders inside, if any. */
  scope?: ItemScope;
}

export type OperationExecuteHandler = (
  operationId: string,
  eventContext: EventContext
) => Promise<void>;

export class ComponentRenderer {
  /**
   * Back-compat wrapper returning a component. Prefer renderElement: a fresh
   * component type per render makes React remount the subtree (inputs lose
   * focus on every keystroke).
   */
  renderUIElement(
    element: UIElement,
    experienceState: ExperienceState,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions = {}
  ): React.ComponentType {
    return () => this.renderElement(element, experienceState, onOperationExecute, options);
  }

  /**
   * Renders a contract element directly as JSX (stable element identity).
   * Resolution (visibility, bindings, rows, control values, fragments) runs
   * through the shared view resolver; this class adds the presentation:
   * React components, knob classes, and handler wiring.
   */
  renderElement(
    element: UIElement,
    experienceState: ExperienceState,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions = {}
  ): React.ReactElement {
    const nodes = resolveViewTree([element], { data: experienceState.data }, options.scope);
    if (nodes.length === 0) {
      return <React.Fragment key={element.id} />;
    }
    return this.renderResolved(nodes[0], onOperationExecute, options);
  }

  private renderResolved(
    node: ResolvedNode,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions
  ): React.ReactElement {
    const finalProps: Record<string, any> = {
      ...node.props,
      ...this.createEventHandlers(node, onOperationExecute),
      'data-element-id': node.id
    };

    this.applyKnobs(node, finalProps);
    this.applyControl(node, finalProps, options);

    // A list with a template carries its resolved rows.
    if (node.rows) {
      return this.renderListRows(node, finalProps, onOperationExecute, options);
    }

    // No children must stay undefined: void elements reject a children prop
    // and the button label falls back only when children are absent.
    const renderChildren = (): React.ReactNode =>
      node.children.length > 0
        ? node.children.map(child => (
            <React.Fragment key={child.id}>
              {this.renderResolved(child, onOperationExecute, options)}
            </React.Fragment>
          ))
        : undefined;

    const ComponentType = UI_COMPONENTS[node.type as keyof typeof UI_COMPONENTS];

    // If known component type
    if (ComponentType) {
      return (
        <ComponentType key={node.id} {...finalProps}>
          {renderChildren()}
        </ComponentType>
      );
    }

    // If intrinsic HTML element (supported lowercase tag), render directly
    if (typeof node.type === 'string' && INTRINSIC_TAGS.has(node.type)) {
      const { content, text, children: _ignored, ...rest } = finalProps as any;
      const children = [] as any[];
      if (content ?? text) children.push(displayable(content ?? text));
      children.push(renderChildren());
      return React.createElement(node.type, { key: node.id, ...rest }, children.length > 0 ? children : undefined);
    }

    // Unknown custom component type fallback
    return (
      <UnknownComponent
        key={node.id}
        element={{ id: node.id, type: node.type, properties: node.props } as unknown as UIElement}
      />
    );
  }

  /**
   * Maps manifest knobs to `type-knob-value` classes. Enum knobs are stripped
   * from the DOM spread (React would warn) and invalid values normalize to
   * the manifest default. String/number knobs stay as props; the part
   * components destructure them away from the DOM.
   */
  private applyKnobs(node: ResolvedNode, finalProps: Record<string, any>): void {
    // A plain form groups children exactly like a container, so it takes the
    // container knobs (and their CSS classes) instead of leaking raw
    // direction/gap/align props into the DOM.
    const manifestType = node.type === 'form' ? 'container' : node.type;
    const manifest = ELEMENT_MANIFESTS[manifestType];
    if (!manifest) return;

    const classes: string[] = [];
    for (const knob of manifest.knobs) {
      if (knob.type !== 'enum') continue;
      let value = finalProps[knob.name] ?? knob.default;
      if (value !== undefined && !(knob.values ?? []).includes(String(value))) {
        console.warn(
          `Element ${node.id}: "${value}" is not a valid ${knob.name}; using "${knob.default}"`
        );
        value = knob.default;
      }
      delete finalProps[knob.name];
      if (value !== undefined) {
        classes.push(`${manifestType}-${knob.name}-${value}`);
      }
    }

    if (classes.length > 0) {
      finalProps.className = [finalProps.className, ...classes].filter(Boolean).join(' ');
    }
  }

  private renderListRows(
    node: ResolvedNode,
    finalProps: Record<string, any>,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions
  ): React.ReactElement {
    const { items: _items, emptyText, children: _children, content: _content, text: _text, ...rest } = finalProps;
    const rows = node.rows ?? [];

    if (rows.length === 0 && emptyText) {
      return (
        <div key={node.id} className="der-empty" data-element-id={node.id}>
          {String(emptyText)}
        </div>
      );
    }

    return (
      <ul key={node.id} {...rest}>
        {rows.map(row => (
          <li key={row.key}>
            {row.children.map(child => (
              <React.Fragment key={child.id}>
                {this.renderResolved(child, onOperationExecute, options)}
              </React.Fragment>
            ))}
          </li>
        ))}
      </ul>
    );
  }

  /**
   * Injects controlled value/onChange for input-like elements so their
   * current value always lives in state under `element_${id}`. Skipped inside
   * list templates: one state key would be shared by every row (in-row
   * checkboxes are binding-driven instead).
   */
  private applyControl(
    node: ResolvedNode,
    finalProps: Record<string, any>,
    options: RenderOptions
  ): void {
    if (!node.control || !options.setElementValue) {
      return;
    }

    const setElementValue = options.setElementValue;
    const isCheckbox = node.control.kind === 'checkbox';
    const boundOnChange = finalProps.onChange as ((event: any) => void) | undefined;

    if (isCheckbox) {
      finalProps.checked = Boolean(node.control.value);
      delete finalProps.value;
    } else {
      finalProps.value = node.control.value;
      delete finalProps.defaultValue;
    }

    finalProps.onChange = (event: any) => {
      const next = isCheckbox ? event?.target?.checked : event?.target?.value;
      setElementValue(node.id, next);
      boundOnChange?.(event);
    };
  }

  private createEventHandlers(
    node: ResolvedNode,
    onOperationExecute: OperationExecuteHandler
  ): Record<string, any> {
    const handlers: Record<string, any> = {};

    // Several bindings may share one event (e.g. click -> add, then click ->
    // recompute); they run sequentially in contract order.
    for (const [eventName, operationIds] of Object.entries(node.events)) {
      handlers[this.getEventHandlerName(eventName)] = async (event: any) => {
        if (eventName === 'submit' && typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        for (const operationId of operationIds) {
          try {
            await onOperationExecute(operationId, { item: node.eventItem });
          } catch (error) {
            // Later bindings usually consume the failed operation's outputs;
            // running them would bury the root error under follow-on noise.
            console.error(
              `Error handling event ${eventName} for operation ${operationId}:`,
              error
            );
            break;
          }
        }
      };
    }

    // A native form submit navigates the webview and wipes the app. Forms
    // always swallow the navigation; a contract-defined submit binding still
    // runs after the default is prevented.
    if (node.type === 'form') {
      const contractSubmit = handlers.onSubmit;
      handlers.onSubmit = async (event: any) => {
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        if (contractSubmit) {
          await contractSubmit(event);
        }
      };
    }

    return handlers;
  }

  private getEventHandlerName(eventType: string): string {
    const eventMap: Record<string, string> = {
      'click': 'onClick',
      'change': 'onChange',
      'submit': 'onSubmit',
      'focus': 'onFocus',
      'blur': 'onBlur',
      'keydown': 'onKeyDown',
      'keyup': 'onKeyUp'
    };

    return eventMap[eventType] || `on${eventType.charAt(0).toUpperCase()}${eventType.slice(1)}`;
  }

}

// Standard UI Components
function ButtonComponent({ children, text, content, type, ...props }: any) {
  // Inside a form a typeless button becomes type="submit" and navigates the
  // webview away; operations wire through eventBindings, so default to a
  // plain button unless the contract asks for a submit type explicitly.
  // Bound labels arrive as "content" (list rows bind item fields onto row
  // buttons), so it labels the button like "text" does.
  return (
    <button type={type ?? 'button'} {...props}>
      {children || displayable(content ?? text)}
    </button>
  );
}

function InputComponent({ label, ...props }: any) {
  const input = <input {...props} />;
  if (label) {
    return (
      <label className="der-field">
        <span>{label}</span>
        {input}
      </label>
    );
  }
  return input;
}

function TextareaComponent({
  label,
  children: _children,
  ...props
}: { label?: string; children?: React.ReactNode } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const area = <textarea {...props} />;
  if (label) {
    return (
      <label className="der-field">
        <span>{label}</span>
        {area}
      </label>
    );
  }
  return area;
}

/**
 * Invisible interval clock. The tick callback lives in a ref so state-driven
 * re-renders do not reset the pending interval; unmounting (visibleWhen going
 * false) stops it.
 */
function TimerComponent({
  seconds,
  onTick,
  'data-element-id': dataElementId
}: {
  seconds?: unknown;
  onTick?: () => void | Promise<void>;
  'data-element-id'?: string;
}) {
  const tickRef = React.useRef(onTick);
  tickRef.current = onTick;
  const intervalSeconds = Number(seconds) > 0 ? Number(seconds) : 1;
  React.useEffect(() => {
    const id = setInterval(() => {
      void tickRef.current?.();
    }, intervalSeconds * 1000);
    return () => clearInterval(id);
  }, [intervalSeconds]);
  return <span data-element-id={dataElementId} style={{ display: 'none' }} />;
}

/** Bound values can resolve to anything; only scalars render as-is. */
function displayable(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return value as React.ReactNode;
  if (typeof value === 'object' && !React.isValidElement(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value as React.ReactNode;
}

function TextComponent({ children, text, content, ...props }: any) {
  const display = children ?? displayable(content ?? text);
  return <span {...props}>{display}</span>;
}

function ContainerComponent({ children, ...props }: any) {
  return <div {...props}>{children}</div>;
}

function ListComponent({ items, renderItem, children, emptyText, ...props }: any) {
  if (items && renderItem) {
    return (
      <ul {...props}>
        {items.map((item: any, index: number) => (
          <li key={index}>{renderItem(item, index)}</li>
        ))}
      </ul>
    );
  }
  if (Array.isArray(items)) {
    if (items.length === 0 && emptyText) {
      return <div className="der-empty">{String(emptyText)}</div>;
    }
    return (
      <ul {...props}>
        {items.map((item: any, index: number) => (
          <li key={index}>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</li>
        ))}
      </ul>
    );
  }
  return <ul {...props}>{children}</ul>;
}

function FormComponent({ children, ...props }: any) {
  return <form {...props}>{children}</form>;
}

/** Models route converter output (raw base64) straight into image src;
 * recognize the common formats and synthesize the data URL. */
function imageSource(src: unknown): string | undefined {
  if (typeof src !== 'string' || src.length === 0) return undefined;
  if (/^[a-z]+:/i.test(src) || src.startsWith('/') || src.startsWith('#')) return src;
  const magic: Array<[string, string]> = [
    ['iVBOR', 'image/png'],
    ['/9j/', 'image/jpeg'],
    ['R0lGOD', 'image/gif'],
    ['UklGR', 'image/webp'],
    ['Qk', 'image/bmp'],
  ];
  for (const [prefix, mime] of magic) {
    if (src.startsWith(prefix)) return `data:${mime};base64,${src}`;
  }
  return src;
}

function ImageComponent({ src, alt, ...props }: any) {
  return <img src={imageSource(src)} alt={alt} {...props} />;
}

/** Themed inline SVG chart: bars or a line over an array of objects. */
function ChartComponent({ data, x, y, emptyText, className, ...props }: any) {
  const rows: Array<Record<string, unknown>> = Array.isArray(data)
    ? data.filter((row) => row && typeof row === 'object')
    : [];
  const xField = typeof x === 'string' && x ? x : 'key';
  const yField = typeof y === 'string' && y ? y : 'sum';
  if (rows.length === 0) {
    return <div className="der-viewer-empty">{emptyText || 'No data yet'}</div>;
  }
  const values = rows.map((row) => Number(row[yField]) || 0);
  const max = Math.max(...values, 0) || 1;
  const width = 420;
  const height = 150;
  const labelBand = 18;
  const plotHeight = height - labelBand;
  const step = width / rows.length;
  const isLine = props.kind === 'line' || className?.includes?.('chart-kind-line');
  const points = values
    .map((value, index) => {
      const px = step * index + step / 2;
      const py = plotHeight - (value / max) * (plotHeight - 8);
      return `${px},${py}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ width: '100%', maxWidth: 560, height: 'auto' }}
      role="img"
    >
      {isLine ? (
        <polyline
          points={points}
          fill="none"
          stroke="var(--der-accent)"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : (
        values.map((value, index) => {
          const barWidth = Math.max(step * 0.6, 4);
          const barHeight = Math.max((value / max) * (plotHeight - 8), 1);
          return (
            <rect
              key={index}
              x={step * index + (step - barWidth) / 2}
              y={plotHeight - barHeight}
              width={barWidth}
              height={barHeight}
              rx="3"
              fill="var(--der-accent)"
            />
          );
        })
      )}
      {rows.map((row, index) => (
        <text
          key={`label-${index}`}
          x={step * index + step / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize="10"
          fill="var(--der-text)"
          opacity="0.7"
        >
          {String(row[xField] ?? '').slice(0, 10)}
        </text>
      ))}
    </svg>
  );
}

function HtmlComponent({ content, emptyText, className, ...props }: any) {
  const text = typeof content === 'string' ? content : '';
  if (!text.trim()) {
    return <div className="der-viewer-empty">{emptyText || 'Nothing to show yet'}</div>;
  }
  return (
    <div
      className={`der-html-content${className ? ` ${className}` : ''}`}
      // Sanitized above: formatting only, nothing executable survives.
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }}
      {...props}
    />
  );
}

function PdfComponent({ src, emptyText, ...props }: any) {
  if (!src) {
    return <div className="der-viewer-empty">{emptyText || 'Open a PDF to view it'}</div>;
  }
  return (
    <embed
      src={src}
      type="application/pdf"
      style={{ width: '100%', minHeight: 420, flex: 1 }}
      {...props}
    />
  );
}

/** The webview face renders pdf and images inline; office formats get an
 * honest handoff (the native face previews them via QuickLook). */
function DocumentComponent({ src, name, emptyText, ...props }: any) {
  if (!src) {
    return <div className="der-viewer-empty">{emptyText || 'Open a document to view it'}</div>;
  }
  const label = typeof name === 'string' && name ? name : String(src);
  const lower = label.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return <PdfComponent src={src} {...props} />;
  }
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) {
    return <ImageComponent src={src} alt={label} {...props} />;
  }
  return (
    <div className="der-viewer-empty">
      {label}: this format previews in DER's native window; use file.save to keep a copy here.
    </div>
  );
}

function VideoComponent({ src, emptyText, ...props }: any) {
  if (!src) {
    return <div className="der-viewer-empty">{emptyText || 'Open a video to play it'}</div>;
  }
  return <video src={src} controls style={{ width: '100%', maxHeight: 480 }} {...props} />;
}

function LinkComponent({ href, children, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
}

interface SelectOption {
  value: string;
  label: string;
}

function normalizeOptions(options: unknown): SelectOption[] {
  // Models sometimes bind options as a JSON string constant; tolerate it.
  if (typeof options === 'string' && options.trim().startsWith('[')) {
    try {
      options = JSON.parse(options);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (option && typeof option === 'object') {
      const record = option as Record<string, unknown>;
      const value = String(record.value ?? '');
      return { value, label: String(record.label ?? value) };
    }
    return { value: String(option), label: String(option) };
  });
}

function SelectComponent({ label, placeholder, options, children: _children, ...props }: any) {
  const normalized = normalizeOptions(options);
  // Without a placeholder the browser shows the first option while the
  // runtime state is still unset; commit it so what you see is what
  // operations read.
  const { value, onChange } = props;
  const commitRef = React.useRef(onChange);
  commitRef.current = onChange;
  const firstValue = normalized[0]?.value;
  // No dependency array: state initialization is async, so the first commit
  // can land before the store exists; retry each render until it sticks.
  React.useEffect(() => {
    if (placeholder === undefined && !value && firstValue) {
      commitRef.current?.({ target: { value: firstValue } });
    }
  });
  const select = (
    <select {...props}>
      {placeholder !== undefined && (props.value === '' || props.value === undefined) && (
        <option value="" disabled>
          {String(placeholder)}
        </option>
      )}
      {normalized.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (label) {
    return (
      <label className="der-field">
        <span>{label}</span>
        {select}
      </label>
    );
  }
  return select;
}

function CheckboxComponent({ label, checked, onChange, children: _children, ...props }: any) {
  const input = (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={onChange}
      readOnly={checked !== undefined && !onChange}
      {...props}
    />
  );
  return (
    <label className="checkbox-part">
      {input}
      {label !== undefined && <span>{String(label)}</span>}
    </label>
  );
}

function ProgressComponent({ value, max, children: _children, ...props }: any) {
  const numericMax = Number(max) || 100;
  const numericValue = Math.min(Math.max(Number(value) || 0, 0), numericMax);
  return <progress value={numericValue} max={numericMax} {...props} />;
}

function DividerComponent({ children: _children, ...props }: any) {
  return <hr className="divider-part" {...props} />;
}

function UnknownComponent({ element }: { element: UIElement }) {
  return (
    <div
      style={{
        border: '2px dashed #ccc',
        padding: '10px',
        margin: '5px',
        backgroundColor: '#f9f9f9'
      }}
    >
      <strong>Unknown Component: {element.type}</strong>
      <pre>{JSON.stringify(element.properties, null, 2)}</pre>
    </div>
  );
}

export default ComponentRenderer;
