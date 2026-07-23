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
import { UIElement, DataBinding, EventBinding, VisibilityCondition } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import {
  ELEMENT_MANIFESTS,
  getValueAtPath,
  looseEquals,
} from '../../services/operations/registry';
import {
  applyBindingTransforms,
  applyTransformPipeline,
} from '../../services/operations/transforms';
import type { EventContext } from './OperationExecutor';

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

const INPUT_LIKE_TYPES = new Set(['input', 'textarea', 'select', 'checkbox']);

export interface ItemScope {
  item: unknown;
  index: number;
}

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

  /** Renders a contract element directly as JSX (stable element identity). */
  renderElement(
    element: UIElement,
    experienceState: ExperienceState,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions = {}
  ): React.ReactElement {
    if (!this.isVisible(element, experienceState, options.scope)) {
      return <React.Fragment key={element.id} />;
    }

    const resolvedProps = this.resolveDataBindings(element, experienceState, options.scope);
    const eventHandlers = this.createEventHandlers(element, onOperationExecute, options.scope);

    const finalProps: Record<string, any> = {
      ...element.properties,
      ...resolvedProps,
      ...eventHandlers,
      'data-element-id': element.id
    };

    this.applyKnobs(element, finalProps);
    this.applyControlledInput(element, experienceState, finalProps, options);

    // A list with children repeats them per item of the bound array.
    if (element.type === 'list' && element.children && element.children.length > 0) {
      return this.renderListTemplate(element, experienceState, onOperationExecute, options, finalProps);
    }

    const renderChildren = (): React.ReactNode =>
      element.children?.map(child => (
        <React.Fragment key={child.id}>
          {this.renderElement(child, experienceState, onOperationExecute, options)}
        </React.Fragment>
      ));

    const ComponentType = UI_COMPONENTS[element.type as keyof typeof UI_COMPONENTS];

    // If known component type
    if (ComponentType) {
      return (
        <ComponentType key={element.id} {...finalProps}>
          {renderChildren()}
        </ComponentType>
      );
    }

    // If intrinsic HTML element (supported lowercase tag), render directly
    if (typeof element.type === 'string' && INTRINSIC_TAGS.has(element.type)) {
      const { content, text, children: _ignored, ...rest } = finalProps as any;
      const children = [] as any[];
      if (content ?? text) children.push(displayable(content ?? text));
      children.push(renderChildren());
      return React.createElement(element.type, { key: element.id, ...rest }, children.length > 0 ? children : undefined);
    }

    // Unknown custom component type fallback
    return <UnknownComponent key={element.id} element={element} />;
  }

  /** Evaluates the element's visibility conditions (an array means AND). */
  private isVisible(
    element: UIElement,
    experienceState: ExperienceState,
    scope?: ItemScope
  ): boolean {
    const raw = element.visibleWhen;
    if (!raw) return true;
    const conditions = Array.isArray(raw) ? raw : [raw];
    return conditions.every(condition => this.evaluateCondition(condition, experienceState, scope));
  }

  private evaluateCondition(
    condition: VisibilityCondition,
    experienceState: ExperienceState,
    scope?: ItemScope
  ): boolean {
    const read =
      condition.source === 'state'
        ? experienceState.data[condition.sourceId]
        : getValueAtPath(scope?.item, condition.sourceId);
    const value = applyTransformPipeline(read, condition.transforms, {
      lookup: (source, sourceId) =>
        experienceState.data[source === 'element' ? `element_${sourceId}` : sourceId]
    });

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
        return looseEquals(value, condition.value);
      case 'notEquals':
        return !looseEquals(value, condition.value);
      case 'gt':
        return Number(value) > Number(condition.value);
      case 'gte':
        return Number(value) >= Number(condition.value);
      case 'lt':
        return Number(value) < Number(condition.value);
      case 'lte':
        return Number(value) <= Number(condition.value);
      default:
        return true;
    }
  }

  /**
   * Maps manifest knobs to `type-knob-value` classes. Enum knobs are stripped
   * from the DOM spread (React would warn) and invalid values normalize to
   * the manifest default. String/number knobs stay as props; the part
   * components destructure them away from the DOM.
   */
  private applyKnobs(element: UIElement, finalProps: Record<string, any>): void {
    // A plain form groups children exactly like a container, so it takes the
    // container knobs (and their CSS classes) instead of leaking raw
    // direction/gap/align props into the DOM.
    const manifestType = element.type === 'form' ? 'container' : element.type;
    const manifest = ELEMENT_MANIFESTS[manifestType];
    if (!manifest) return;

    const classes: string[] = [];
    for (const knob of manifest.knobs) {
      if (knob.type !== 'enum') continue;
      let value = finalProps[knob.name] ?? knob.default;
      if (value !== undefined && !(knob.values ?? []).includes(String(value))) {
        console.warn(
          `Element ${element.id}: "${value}" is not a valid ${knob.name}; using "${knob.default}"`
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

  private renderListTemplate(
    element: UIElement,
    experienceState: ExperienceState,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions,
    finalProps: Record<string, any>
  ): React.ReactElement {
    const { items, emptyText, children: _children, content: _content, text: _text, ...rest } = finalProps;
    const array: unknown[] = Array.isArray(items) ? items : [];

    if (array.length === 0 && emptyText) {
      return (
        <div key={element.id} className="der-empty" data-element-id={element.id}>
          {String(emptyText)}
        </div>
      );
    }

    return (
      <ul key={element.id} {...rest}>
        {array.map((item, index) => {
          const scope: ItemScope = { item, index };
          const record = item as Record<string, unknown> | null;
          const key =
            record && typeof record === 'object' && record.id !== undefined
              ? String(record.id)
              : String(index);
          return (
            <li key={key}>
              {element.children!.map(child => (
                <React.Fragment key={child.id}>
                  {this.renderElement(child, experienceState, onOperationExecute, { ...options, scope })}
                </React.Fragment>
              ))}
            </li>
          );
        })}
      </ul>
    );
  }

  /**
   * Injects controlled value/onChange for input-like elements so their
   * current value always lives in state under `element_${id}`. Skipped inside
   * list templates: one state key would be shared by every row (in-row
   * checkboxes are binding-driven instead).
   */
  private applyControlledInput(
    element: UIElement,
    experienceState: ExperienceState,
    finalProps: Record<string, any>,
    options: RenderOptions
  ): void {
    if (!INPUT_LIKE_TYPES.has(element.type) || !options.setElementValue || options.scope) {
      return;
    }

    const setElementValue = options.setElementValue;
    const stateValue = experienceState.data[`element_${element.id}`];
    const isCheckbox = element.type === 'checkbox' || finalProps.type === 'checkbox';
    const boundOnChange = finalProps.onChange as ((event: any) => void) | undefined;

    if (isCheckbox) {
      finalProps.checked = Boolean(stateValue);
      delete finalProps.value;
    } else {
      finalProps.value = stateValue ?? element.properties?.defaultValue ?? '';
      delete finalProps.defaultValue;
    }

    finalProps.onChange = (event: any) => {
      const next = isCheckbox ? event?.target?.checked : event?.target?.value;
      setElementValue(element.id, next);
      boundOnChange?.(event);
    };
  }

  private resolveDataBindings(
    element: UIElement,
    experienceState: ExperienceState,
    scope?: ItemScope
  ): Record<string, any> {
    const resolvedProps: Record<string, any> = {};

    element.dataBindings.forEach(binding => {
      const value = this.resolveDataBinding(binding, experienceState, scope);
      resolvedProps[binding.property] = value;
    });

    return resolvedProps;
  }

  private resolveDataBinding(
    binding: DataBinding,
    experienceState: ExperienceState,
    scope?: ItemScope
  ): any {
    let value: any;

    switch (binding.source) {
      case 'state':
        value = experienceState.data[binding.sourceId];
        break;
      case 'operation':
        value = experienceState.data[`operation_${binding.sourceId}`];
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
        experienceState.data[source === 'element' ? `element_${sourceId}` : sourceId]
    });
  }

  private createEventHandlers(
    element: UIElement,
    onOperationExecute: OperationExecuteHandler,
    scope?: ItemScope
  ): Record<string, any> {
    const handlers: Record<string, any> = {};

    // Several bindings may share one event (e.g. click -> add, then click ->
    // recompute); they run sequentially in contract order.
    const byHandler = new Map<string, EventBinding[]>();
    for (const binding of element.eventBindings) {
      const handlerName = this.getEventHandlerName(binding.event);
      const list = byHandler.get(handlerName) ?? [];
      list.push(binding);
      byHandler.set(handlerName, list);
    }

    byHandler.forEach((bindings, handlerName) => {
      handlers[handlerName] = async (event: any) => {
        for (const binding of bindings) {
          await this.handleEvent(binding, event, onOperationExecute, scope);
        }
      };
    });

    // A native form submit navigates the webview and wipes the app. Forms
    // always swallow the navigation; a contract-defined submit binding still
    // runs after the default is prevented.
    if (element.type === 'form') {
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

  private async handleEvent(
    binding: EventBinding,
    event: any,
    onOperationExecute: OperationExecuteHandler,
    scope?: ItemScope
  ): Promise<void> {
    if (binding.event === 'submit' && typeof event?.preventDefault === 'function') {
      event.preventDefault();
    }
    try {
      await onOperationExecute(binding.operationId, { item: scope?.item });
    } catch (error) {
      console.error(`Error handling event ${binding.event} for operation ${binding.operationId}:`, error);
    }
  }
}

// Standard UI Components
function ButtonComponent({ children, text, type, ...props }: any) {
  // Inside a form a typeless button becomes type="submit" and navigates the
  // webview away; operations wire through eventBindings, so default to a
  // plain button unless the contract asks for a submit type explicitly.
  return (
    <button type={type ?? 'button'} {...props}>
      {children || text}
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

function TextareaComponent({ label, children: _children, ...props }: any) {
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
function TimerComponent({ seconds, onTick, 'data-element-id': dataElementId }: any) {
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

function ImageComponent({ src, alt, ...props }: any) {
  return <img src={src} alt={alt} {...props} />;
}

function LinkComponent({ href, children, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
}

interface SelectOption {
  value: string;
  label: string;
}

function normalizeOptions(options: unknown): SelectOption[] {
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
