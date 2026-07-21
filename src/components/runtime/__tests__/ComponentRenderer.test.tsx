/**
 * Tests for the Component Renderer. Covers element rendering, data bindings,
 * auto-controlled inputs, list templates with per-item scope, and event
 * bindings that pass the event context through to operations.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentRenderer } from '../ComponentRenderer';
import { UIElement } from '../../../types/contract';
import { ExperienceState } from '../../../types/experience';

function stateWithData(data: Record<string, unknown>): ExperienceState {
  return {
    data,
    loading: {},
    errors: {},
    lastUpdated: new Date()
  };
}

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

  it('handles click events with the event context', () => {
    const buttonElement: UIElement = {
      id: 'btn1',
      type: 'button',
      properties: { text: 'Click me' },
      dataBindings: [],
      eventBindings: [
        {
          event: 'click',
          operationId: 'op1',
          // Legacy parameters are ignored by the runtime.
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

    expect(mockOnOperationExecute).toHaveBeenCalledWith('op1', { item: undefined });
  });

  it('handles change events with the event context', () => {
    const inputElement: UIElement = {
      id: 'input1',
      type: 'input',
      properties: {},
      dataBindings: [],
      eventBindings: [
        {
          event: 'change',
          operationId: 'op2'
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

    expect(mockOnOperationExecute).toHaveBeenCalledWith('op2', { item: undefined });
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
    expect(mockOnOperationExecute).toHaveBeenCalledWith('op1', { item: undefined });

    fireEvent.focus(button);
    expect(mockOnOperationExecute).toHaveBeenCalledWith('op2', { item: undefined });
  });

  describe('controlled inputs', () => {
    it('drives the input value from state and writes changes back', () => {
      const setElementValue = vi.fn();
      const inputElement: UIElement = {
        id: 'input1',
        type: 'input',
        properties: { placeholder: 'Type here' },
        dataBindings: [],
        eventBindings: []
      };

      const RenderedComponent = componentRenderer.renderUIElement(
        inputElement,
        stateWithData({ element_input1: 'from state' }),
        mockOnOperationExecute,
        { setElementValue }
      );
      render(<RenderedComponent />);

      const input = screen.getByPlaceholderText('Type here');
      expect(input).toHaveValue('from state');

      fireEvent.change(input, { target: { value: 'updated' } });
      expect(setElementValue).toHaveBeenCalledWith('input1', 'updated');
    });

    it('falls back to defaultValue and then to an empty string', () => {
      const setElementValue = vi.fn();
      const seeded: UIElement = {
        id: 'seeded',
        type: 'input',
        properties: { placeholder: 'Seeded', defaultValue: 'seed' },
        dataBindings: [],
        eventBindings: []
      };
      const blank: UIElement = {
        id: 'blank',
        type: 'input',
        properties: { placeholder: 'Blank' },
        dataBindings: [],
        eventBindings: []
      };

      const SeededComponent = componentRenderer.renderUIElement(
        seeded,
        stateWithData({}),
        mockOnOperationExecute,
        { setElementValue }
      );
      const BlankComponent = componentRenderer.renderUIElement(
        blank,
        stateWithData({}),
        mockOnOperationExecute,
        { setElementValue }
      );
      render(
        <>
          <SeededComponent />
          <BlankComponent />
        </>
      );

      expect(screen.getByPlaceholderText('Seeded')).toHaveValue('seed');
      expect(screen.getByPlaceholderText('Blank')).toHaveValue('');
    });

    it('writes the value before running a bound change operation', () => {
      const setElementValue = vi.fn();
      const inputElement: UIElement = {
        id: 'input1',
        type: 'input',
        properties: { placeholder: 'Chained' },
        dataBindings: [],
        eventBindings: [{ event: 'change', operationId: 'op-change' }]
      };

      const RenderedComponent = componentRenderer.renderUIElement(
        inputElement,
        stateWithData({}),
        mockOnOperationExecute,
        { setElementValue }
      );
      render(<RenderedComponent />);

      fireEvent.change(screen.getByPlaceholderText('Chained'), { target: { value: 'abc' } });

      expect(setElementValue).toHaveBeenCalledWith('input1', 'abc');
      expect(mockOnOperationExecute).toHaveBeenCalledWith('op-change', { item: undefined });
      expect(setElementValue.mock.invocationCallOrder[0]).toBeLessThan(
        mockOnOperationExecute.mock.invocationCallOrder[0]
      );
    });

    it('controls checkboxes through the checked property', () => {
      const setElementValue = vi.fn();
      const checkboxElement: UIElement = {
        id: 'check1',
        type: 'input',
        properties: { type: 'checkbox' },
        dataBindings: [],
        eventBindings: []
      };

      const RenderedComponent = componentRenderer.renderUIElement(
        checkboxElement,
        stateWithData({ element_check1: false }),
        mockOnOperationExecute,
        { setElementValue }
      );
      render(<RenderedComponent />);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);
      expect(setElementValue).toHaveBeenCalledWith('check1', true);
    });

    it('controls textarea elements as well', () => {
      const setElementValue = vi.fn();
      const textareaElement: UIElement = {
        id: 'notes',
        type: 'textarea',
        properties: { placeholder: 'Notes' },
        dataBindings: [],
        eventBindings: []
      };

      const RenderedComponent = componentRenderer.renderUIElement(
        textareaElement,
        stateWithData({ element_notes: 'saved note' }),
        mockOnOperationExecute,
        { setElementValue }
      );
      render(<RenderedComponent />);

      const textarea = screen.getByPlaceholderText('Notes');
      expect(textarea).toHaveValue('saved note');

      fireEvent.change(textarea, { target: { value: 'edited' } });
      expect(setElementValue).toHaveBeenCalledWith('notes', 'edited');
    });

    it('leaves inputs uncontrolled when no setElementValue is provided', () => {
      const inputElement: UIElement = {
        id: 'free',
        type: 'input',
        properties: { placeholder: 'Free', defaultValue: 'seed' },
        dataBindings: [],
        eventBindings: []
      };

      const RenderedComponent = componentRenderer.renderUIElement(
        inputElement,
        stateWithData({}),
        mockOnOperationExecute
      );
      render(<RenderedComponent />);

      const input = screen.getByPlaceholderText('Free');
      expect(input).toHaveValue('seed');

      fireEvent.change(input, { target: { value: 'typed' } });
      expect(input).toHaveValue('typed');
    });
  });

  describe('list templates', () => {
    const makeListElement = (children: UIElement[]): UIElement => ({
      id: 'list1',
      type: 'list',
      properties: {},
      dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
      eventBindings: [],
      children
    });

    it('renders one list item per entry with item bindings resolved', () => {
      const listElement = makeListElement([
        {
          id: 'title',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'text', source: 'item', sourceId: 'title' }],
          eventBindings: []
        }
      ]);
      const state = stateWithData({
        todos: [
          { id: 't1', title: 'First' },
          { id: 't2', title: 'Second' }
        ]
      });

      const RenderedComponent = componentRenderer.renderUIElement(
        listElement,
        state,
        mockOnOperationExecute
      );
      const { container } = render(<RenderedComponent />);

      expect(container.querySelector('ul')).not.toBeNull();
      expect(container.querySelectorAll('li')).toHaveLength(2);
      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
    });

    it('resolves dot paths into the scoped item', () => {
      const listElement = makeListElement([
        {
          id: 'owner',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'text', source: 'item', sourceId: 'user.name' }],
          eventBindings: []
        }
      ]);
      const state = stateWithData({ todos: [{ user: { name: 'Ada' } }] });

      const RenderedComponent = componentRenderer.renderUIElement(
        listElement,
        state,
        mockOnOperationExecute
      );
      render(<RenderedComponent />);

      expect(screen.getByText('Ada')).toBeInTheDocument();
    });

    it('resolves an empty item path to the whole entry', () => {
      const listElement = makeListElement([
        {
          id: 'entry',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'text', source: 'item', sourceId: '' }],
          eventBindings: []
        }
      ]);
      const state = stateWithData({ todos: ['alpha', 'beta'] });

      const RenderedComponent = componentRenderer.renderUIElement(
        listElement,
        state,
        mockOnOperationExecute
      );
      render(<RenderedComponent />);

      expect(screen.getByText('alpha')).toBeInTheDocument();
      expect(screen.getByText('beta')).toBeInTheDocument();
    });

    it('passes the scoped item to event handlers', () => {
      const listElement = makeListElement([
        {
          id: 'remove',
          type: 'button',
          properties: { text: 'Remove' },
          dataBindings: [],
          eventBindings: [{ event: 'click', operationId: 'op-remove' }]
        }
      ]);
      const todos = [
        { id: 't1', title: 'First' },
        { id: 't2', title: 'Second' }
      ];

      const RenderedComponent = componentRenderer.renderUIElement(
        listElement,
        stateWithData({ todos }),
        mockOnOperationExecute
      );
      render(<RenderedComponent />);

      fireEvent.click(screen.getAllByRole('button')[1]);
      expect(mockOnOperationExecute).toHaveBeenCalledWith('op-remove', { item: todos[1] });
    });

    it('renders an empty list when the bound items are missing', () => {
      const listElement = makeListElement([
        {
          id: 'title',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'text', source: 'item', sourceId: 'title' }],
          eventBindings: []
        }
      ]);

      const RenderedComponent = componentRenderer.renderUIElement(
        listElement,
        stateWithData({}),
        mockOnOperationExecute
      );
      const { container } = render(<RenderedComponent />);

      expect(container.querySelector('ul')).not.toBeNull();
      expect(container.querySelectorAll('li')).toHaveLength(0);
    });
  });

  describe('form submission', () => {
    it('prevents default and passes the context on submit bindings', () => {
      const formElement: UIElement = {
        id: 'form1',
        type: 'form',
        properties: {},
        dataBindings: [],
        eventBindings: [{ event: 'submit', operationId: 'op-submit' }],
        children: [
          {
            id: 'go',
            type: 'button',
            properties: { text: 'Go' },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      const RenderedComponent = componentRenderer.renderUIElement(
        formElement,
        stateWithData({}),
        mockOnOperationExecute
      );
      const { container } = render(<RenderedComponent />);

      const form = container.querySelector('form');
      expect(form).not.toBeNull();

      // fireEvent returns false when preventDefault was called on the event.
      const defaultNotPrevented = fireEvent.submit(form!);
      expect(defaultNotPrevented).toBe(false);
      expect(mockOnOperationExecute).toHaveBeenCalledWith('op-submit', { item: undefined });
    });
  });
});