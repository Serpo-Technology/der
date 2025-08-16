/**
 * Tests for Component Renderer
 * Requirements: 3.1, 3.2, 9.1
 */

// React import removed - not needed in test files with modern React
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentRenderer } from '../ComponentRenderer';
// Unused imports removed
import { UIElement } from '../../../types/contract';
import { ExperienceState } from '../../../types/experience';

// Mock dependencies
// Mock objects removed as they're not used anymore

describe('ComponentRenderer', () => {
  let componentRenderer: ComponentRenderer;
  const mockOnOperationExecute = vi.fn();

  const mockExperienceState: ExperienceState = {
    data: {
      'testData': 'Hello World',
      'operation_op1_result': 'Operation Result'
    },
    loading: {},
    errors: {},
    lastUpdated: new Date()
  };

  beforeEach(() => {
    componentRenderer = new ComponentRenderer();
    vi.clearAllMocks();
  });

  it('renders button component correctly', () => {
    const buttonElement: UIElement = {
      id: 'btn1',
      type: 'button',
      properties: { text: 'Click me' },
      dataBindings: [],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      buttonElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('Click me');
    expect(button).toHaveAttribute('data-element-id', 'btn1');
  });

  it('renders input component correctly', () => {
    const inputElement: UIElement = {
      id: 'input1',
      type: 'input',
      properties: { placeholder: 'Enter text' },
      dataBindings: [],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      inputElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const input = screen.getByPlaceholderText('Enter text');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('data-element-id', 'input1');
  });

  it('renders text component correctly', () => {
    const textElement: UIElement = {
      id: 'text1',
      type: 'text',
      properties: { text: 'Hello World' },
      dataBindings: [],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      textElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const text = screen.getByText('Hello World');
    expect(text).toBeInTheDocument();
    expect(text).toHaveAttribute('data-element-id', 'text1');
  });

  it('renders container with children', () => {
    const containerElement: UIElement = {
      id: 'container1',
      type: 'container',
      properties: { className: 'test-container' },
      dataBindings: [],
      eventBindings: [],
      children: [
        {
          id: 'child1',
          type: 'text',
          properties: { text: 'Child Text' },
          dataBindings: [],
          eventBindings: []
        }
      ]
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      containerElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const container = screen.getByText('Child Text').parentElement;
    expect(container).toHaveClass('test-container');
    expect(container).toHaveAttribute('data-element-id', 'container1');
    expect(screen.getByText('Child Text')).toBeInTheDocument();
  });

  it('resolves data bindings correctly', () => {
    const textElement: UIElement = {
      id: 'text1',
      type: 'text',
      properties: {},
      dataBindings: [
        {
          property: 'text',
          source: 'state',
          sourceId: 'testData'
        }
      ],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      textElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('resolves operation data bindings', () => {
    const textElement: UIElement = {
      id: 'text1',
      type: 'text',
      properties: {},
      dataBindings: [
        {
          property: 'text',
          source: 'operation',
          sourceId: 'op1_result'
        }
      ],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      textElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    expect(screen.getByText('Operation Result')).toBeInTheDocument();
  });

  it('resolves constant data bindings', () => {
    const textElement: UIElement = {
      id: 'text1',
      type: 'text',
      properties: {},
      dataBindings: [
        {
          property: 'text',
          source: 'constant',
          sourceId: 'Constant Value'
        }
      ],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      textElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    expect(screen.getByText('Constant Value')).toBeInTheDocument();
  });

  it('applies format transforms', () => {
    const textElement: UIElement = {
      id: 'text1',
      type: 'text',
      properties: {},
      dataBindings: [
        {
          property: 'text',
          source: 'state',
          sourceId: 'testData',
          transform: {
            type: 'format',
            parameters: { template: 'Formatted: {{value}}' }
          }
        }
      ],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      textElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    expect(screen.getByText('Formatted: Hello World')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const buttonElement: UIElement = {
      id: 'btn1',
      type: 'button',
      properties: { text: 'Click me' },
      dataBindings: [],
      eventBindings: [
        {
          event: 'click',
          operationId: 'op1',
          parameters: { action: 'test' }
        }
      ]
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      buttonElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(mockOnOperationExecute).toHaveBeenCalledWith('op1', [
      { name: 'action', value: 'test' }
    ]);
  });

  it('handles change events with event data', () => {
    const inputElement: UIElement = {
      id: 'input1',
      type: 'input',
      properties: {},
      dataBindings: [],
      eventBindings: [
        {
          event: 'change',
          operationId: 'op2',
          parameters: { includeEventData: true }
        }
      ]
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      inputElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'test input' } });

    expect(mockOnOperationExecute).toHaveBeenCalledWith('op2', [
      {
        type: 'event',
        value: 'test input',
        target: expect.any(Object)
      }
    ]);
  });

  it('renders unknown components with fallback', () => {
    const unknownElement: UIElement = {
      id: 'unknown1',
      type: 'unknown-component',
      properties: { customProp: 'test' },
      dataBindings: [],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      unknownElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    expect(screen.getByText('Unknown Component: unknown-component')).toBeInTheDocument();
    expect(screen.getByText(/"customProp": "test"/)).toBeInTheDocument();
  });

  it('renders list component with items', () => {
    const listElement: UIElement = {
      id: 'list1',
      type: 'list',
      properties: {
        items: ['Item 1', 'Item 2', 'Item 3'],
        renderItem: (item: string) => item
      },
      dataBindings: [],
      eventBindings: []
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      listElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  it('handles multiple event bindings', () => {
    const buttonElement: UIElement = {
      id: 'btn1',
      type: 'button',
      properties: { text: 'Multi Event Button' },
      dataBindings: [],
      eventBindings: [
        {
          event: 'click',
          operationId: 'op1'
        },
        {
          event: 'focus',
          operationId: 'op2'
        }
      ]
    };

    const RenderedComponent = componentRenderer.renderUIElement(
      buttonElement,
      mockExperienceState,
      mockOnOperationExecute
    );

    render(<RenderedComponent />);

    const button = screen.getByRole('button');
    
    fireEvent.click(button);
    expect(mockOnOperationExecute).toHaveBeenCalledWith('op1', []);
    
    fireEvent.focus(button);
    expect(mockOnOperationExecute).toHaveBeenCalledWith('op2', []);
  });
});