/**
 * Component Renderer - Renders individual UI elements from contracts.
 *
 * Conventions the renderer implements:
 * - input-like elements are auto-controlled: their value lives in state under
 *   `element_${id}` and every keystroke writes it back;
 * - a `list` element with children repeats them per entry of its bound
 *   `items` array, exposing the entry to bindings with source 'item';
 * - event bindings call operations with the current item as event context.
 */

import React from 'react';
import { UIElement, DataBinding, EventBinding } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { getValueAtPath } from '../../services/operations/registry';
import type { EventContext } from './OperationExecutor';

// Standard UI component registry
const UI_COMPONENTS = {
  'button': ButtonComponent,
  'input': InputComponent,
  'text': TextComponent,
  'container': ContainerComponent,
  'list': ListComponent,
  'form': FormComponent,
  'image': ImageComponent,
  'link': LinkComponent
};

// Supported intrinsic HTML tags for 1:1 contract rendering
const INTRINSIC_TAGS = new Set([
  'div','span','p','button','input','form','ul','ol','li','img','a','label','section','header','footer','main','nav','article','aside','h1','h2','h3','h4','h5','h6','textarea','select','option'
]);

const INPUT_LIKE_TYPES = new Set(['input', 'textarea', 'select']);

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
    const resolvedProps = this.resolveDataBindings(element, experienceState, options.scope);
    const eventHandlers = this.createEventHandlers(element, onOperationExecute, options.scope);

    const finalProps: Record<string, any> = {
      ...element.properties,
      ...resolvedProps,
      ...eventHandlers,
      'data-element-id': element.id
    };

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
      if (content || text) children.push(content ?? text);
      children.push(renderChildren());
      return React.createElement(element.type, { key: element.id, ...rest }, children.length > 0 ? children : undefined);
    }

    // Unknown custom component type fallback
    return <UnknownComponent key={element.id} element={element} />;
  }

  private renderListTemplate(
    element: UIElement,
    experienceState: ExperienceState,
    onOperationExecute: OperationExecuteHandler,
    options: RenderOptions,
    finalProps: Record<string, any>
  ): React.ReactElement {
    const { items, children: _children, content: _content, text: _text, ...rest } = finalProps;
    const array: unknown[] = Array.isArray(items) ? items : [];

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
   * current value always lives in state under `element_${id}`.
   */
  private applyControlledInput(
    element: UIElement,
    experienceState: ExperienceState,
    finalProps: Record<string, any>,
    options: RenderOptions
  ): void {
    if (!INPUT_LIKE_TYPES.has(element.type) || !options.setElementValue) {
      return;
    }

    const setElementValue = options.setElementValue;
    const stateValue = experienceState.data[`element_${element.id}`];
    const isCheckbox = finalProps.type === 'checkbox';
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
        value = binding.sourceId;
        break;
      case 'item':
        value = getValueAtPath(scope?.item, binding.sourceId);
        break;
      default:
        value = null;
    }

    // Apply transform if specified
    if (binding.transform && value !== null && value !== undefined) {
      value = this.applyTransform(value, binding.transform);
    }

    return value;
  }

  private applyTransform(value: any, transform: any): any {
    // Simple transform implementation - can be extended
    switch (transform.type) {
      case 'format':
        if (typeof value === 'string' && transform.parameters.template) {
          return transform.parameters.template.replace('{{value}}', value);
        }
        return value;
      case 'map':
        if (transform.parameters.mapping && typeof transform.parameters.mapping === 'object') {
          return transform.parameters.mapping[value] ?? value;
        }
        return value;
      case 'filter':
        if (Array.isArray(value) && transform.parameters.condition) {
          // Simple filter implementation
          return value.filter(item => this.evaluateCondition(item, transform.parameters.condition));
        }
        return value;
      default:
        return value;
    }
  }

  private evaluateCondition(item: any, condition: string): boolean {
    // Simple condition evaluation - can be extended with a proper expression parser
    try {
      return new Function('item', `return ${condition}`)(item);
    } catch {
      return true;
    }
  }

  private createEventHandlers(
    element: UIElement,
    onOperationExecute: OperationExecuteHandler,
    scope?: ItemScope
  ): Record<string, any> {
    const handlers: Record<string, any> = {};

    element.eventBindings.forEach(binding => {
      const handlerName = this.getEventHandlerName(binding.event);
      handlers[handlerName] = (event: any) => {
        this.handleEvent(binding, event, onOperationExecute, scope);
      };
    });

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
function ButtonComponent({ children, text, ...props }: any) {
  return <button {...props}>{children || text}</button>;
}

function InputComponent({ ...props }: any) {
  return <input {...props} />;
}

function TextComponent({ children, text, content, ...props }: any) {
  const display = children || content || text;
  return <span {...props}>{display}</span>;
}

function ContainerComponent({ children, ...props }: any) {
  return <div {...props}>{children}</div>;
}

function ListComponent({ items, renderItem, children, ...props }: any) {
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
