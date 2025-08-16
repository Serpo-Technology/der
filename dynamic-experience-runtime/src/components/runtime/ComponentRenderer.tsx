/**
 * Component Renderer - Renders individual UI elements from contracts
 * Requirements: 3.1, 3.2, 9.1
 */

import React from 'react';
import { UIElement, DataBinding, EventBinding } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
// ExperienceStateManager and OperationExecutor imports removed as they're not used

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

// ComponentRendererProps interface removed as it's not used

export class ComponentRenderer {
  // No constructor parameters needed as this class is stateless

  renderUIElement(
    element: UIElement,
    experienceState: ExperienceState,
    onOperationExecute: (operationId: string, inputs: any[]) => Promise<void>
  ): React.ComponentType {
    return () => {
      const resolvedProps = this.resolveDataBindings(element, experienceState);
      const eventHandlers = this.createEventHandlers(element, onOperationExecute);
      
      const ComponentType = UI_COMPONENTS[element.type as keyof typeof UI_COMPONENTS];
      
      if (!ComponentType) {
        return <UnknownComponent element={element} />;
      }

      const finalProps = {
        ...element.properties,
        ...resolvedProps,
        ...eventHandlers,
        'data-element-id': element.id
      };

      return (
        <ComponentType key={element.id} {...finalProps}>
          {element.children && element.children.map(child => {
            const ChildComponent = this.renderUIElement(child, experienceState, onOperationExecute);
            return <ChildComponent key={child.id} />;
          })}
        </ComponentType>
      );
    };
  }

  private resolveDataBindings(element: UIElement, experienceState: ExperienceState): Record<string, any> {
    const resolvedProps: Record<string, any> = {};

    element.dataBindings.forEach(binding => {
      const value = this.resolveDataBinding(binding, experienceState);
      resolvedProps[binding.property] = value;
    });

    return resolvedProps;
  }

  private resolveDataBinding(binding: DataBinding, experienceState: ExperienceState): any {
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
          return transform.parameters.mapping[value] || value;
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
    onOperationExecute: (operationId: string, inputs: any[]) => Promise<void>
  ): Record<string, any> {
    const handlers: Record<string, any> = {};

    element.eventBindings.forEach(binding => {
      const handlerName = this.getEventHandlerName(binding.event);
      handlers[handlerName] = (event: any) => {
        this.handleEvent(binding, event, onOperationExecute);
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
    onOperationExecute: (operationId: string, inputs: any[]) => Promise<void>
  ): Promise<void> {
    try {
      // Prepare inputs from event and parameters
      const inputs = this.prepareOperationInputs(binding, event);
      await onOperationExecute(binding.operationId, inputs);
    } catch (error) {
      console.error(`Error handling event ${binding.event} for operation ${binding.operationId}:`, error);
    }
  }

  private prepareOperationInputs(binding: EventBinding, event: any): any[] {
    const inputs: any[] = [];

    // Add event data if needed
    if (binding.parameters?.includeEventData) {
      inputs.push({
        type: 'event',
        value: event.target?.value || event,
        target: event.target
      });
    }

    // Add custom parameters
    if (binding.parameters) {
      Object.entries(binding.parameters).forEach(([key, value]) => {
        if (key !== 'includeEventData') {
          inputs.push({ name: key, value });
        }
      });
    }

    return inputs;
  }
}

// Standard UI Components
function ButtonComponent({ children, text, ...props }: any) {
  return <button {...props}>{children || text}</button>;
}

function InputComponent({ ...props }: any) {
  return <input {...props} />;
}

function TextComponent({ children, text, ...props }: any) {
  return <span {...props}>{children || text}</span>;
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