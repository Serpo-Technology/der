/**
 * Tests for the renderer's declarative parts: visibleWhen conditions
 * (including item scope and transform pipelines), manifest knob classes,
 * auto-controlled select and checkbox elements, the list emptyText knob, and
 * the input label knob.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentRenderer } from '../ComponentRenderer';
import { UIElement, VisibilityCondition } from '../../../types/contract';
import { ExperienceState } from '../../../types/experience';

function stateWithData(data: Record<string, unknown>): ExperienceState {
  return {
    data,
    loading: {},
    errors: {},
    lastUpdated: new Date()
  };
}

describe('ComponentRenderer knobs and visibility', () => {
  let renderer: ComponentRenderer;
  const mockOnOperationExecute = vi.fn();

  beforeEach(() => {
    renderer = new ComponentRenderer();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderContract(
    element: UIElement,
    data: Record<string, unknown> = {},
    options: { setElementValue?: (elementId: string, value: unknown) => void } = {}
  ) {
    return render(
      renderer.renderElement(element, stateWithData(data), mockOnOperationExecute, options)
    );
  }

  describe('visibleWhen', () => {
    function conditionVisible(
      visibleWhen: UIElement['visibleWhen'],
      data: Record<string, unknown>
    ): boolean {
      const element: UIElement = {
        id: 'target',
        type: 'text',
        properties: { content: 'conditional content' },
        dataBindings: [],
        eventBindings: [],
        visibleWhen
      };
      const { container, unmount } = renderContract(element, data);
      const visible = container.querySelector('[data-element-id="target"]') !== null;
      unmount();
      return visible;
    }

    it('gates rendering on state truthiness', () => {
      const truthy: VisibilityCondition = { source: 'state', sourceId: 'flag', operator: 'truthy' };
      const falsy: VisibilityCondition = { source: 'state', sourceId: 'flag', operator: 'falsy' };

      expect(conditionVisible(truthy, { flag: true })).toBe(true);
      expect(conditionVisible(truthy, { flag: false })).toBe(false);
      expect(conditionVisible(truthy, {})).toBe(false);
      expect(conditionVisible(falsy, { flag: 0 })).toBe(true);
      expect(conditionVisible(falsy, { flag: 'yes' })).toBe(false);
    });

    it('evaluates empty and notEmpty on arrays', () => {
      const empty: VisibilityCondition = { source: 'state', sourceId: 'rows', operator: 'empty' };
      const notEmpty: VisibilityCondition = {
        source: 'state',
        sourceId: 'rows',
        operator: 'notEmpty'
      };

      expect(conditionVisible(empty, { rows: [] })).toBe(true);
      expect(conditionVisible(empty, { rows: [1] })).toBe(false);
      expect(conditionVisible(empty, {})).toBe(true);
      expect(conditionVisible(notEmpty, { rows: [1] })).toBe(true);
      expect(conditionVisible(notEmpty, { rows: [] })).toBe(false);
    });

    it('evaluates empty and notEmpty on strings', () => {
      const empty: VisibilityCondition = { source: 'state', sourceId: 'query', operator: 'empty' };
      const notEmpty: VisibilityCondition = {
        source: 'state',
        sourceId: 'query',
        operator: 'notEmpty'
      };

      expect(conditionVisible(empty, { query: '' })).toBe(true);
      expect(conditionVisible(empty, { query: 'shoes' })).toBe(false);
      expect(conditionVisible(notEmpty, { query: 'shoes' })).toBe(true);
      expect(conditionVisible(notEmpty, { query: '' })).toBe(false);
    });

    it('compares equals against a typed value', () => {
      const condition: VisibilityCondition = {
        source: 'state',
        sourceId: 'showDone',
        operator: 'equals',
        value: true
      };

      expect(conditionVisible(condition, { showDone: true })).toBe(true);
      expect(conditionVisible(condition, { showDone: false })).toBe(false);
    });

    it('compares gt and lt numerically', () => {
      const gt: VisibilityCondition = { source: 'state', sourceId: 'count', operator: 'gt', value: 2 };
      const lt: VisibilityCondition = { source: 'state', sourceId: 'count', operator: 'lt', value: 2 };

      expect(conditionVisible(gt, { count: 3 })).toBe(true);
      expect(conditionVisible(gt, { count: 2 })).toBe(false);
      expect(conditionVisible(lt, { count: 1 })).toBe(true);
      expect(conditionVisible(lt, { count: 5 })).toBe(false);
    });

    it('requires every condition in an array to hold', () => {
      const conditions: VisibilityCondition[] = [
        { source: 'state', sourceId: 'flag', operator: 'truthy' },
        { source: 'state', sourceId: 'count', operator: 'gt', value: 2 }
      ];

      expect(conditionVisible(conditions, { flag: true, count: 3 })).toBe(true);
      expect(conditionVisible(conditions, { flag: true, count: 1 })).toBe(false);
      expect(conditionVisible(conditions, { flag: false, count: 3 })).toBe(false);
    });

    it('applies a condition transform pipeline before comparing', () => {
      const condition: VisibilityCondition = {
        source: 'state',
        sourceId: 'todos',
        operator: 'gt',
        value: 0,
        transforms: [
          { type: 'filterBy', parameters: { field: 'completed', value: 'false' } },
          { type: 'count', parameters: {} }
        ]
      };

      expect(
        conditionVisible(condition, { todos: [{ completed: false }, { completed: true }] })
      ).toBe(true);
      expect(conditionVisible(condition, { todos: [{ completed: true }] })).toBe(false);
    });

    it('hides template content whose item-scoped condition fails', () => {
      const listElement: UIElement = {
        id: 'todo-list',
        type: 'list',
        properties: {},
        dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
        eventBindings: [],
        children: [
          {
            id: 'row-title',
            type: 'text',
            properties: {},
            dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
            eventBindings: [],
            visibleWhen: { source: 'item', sourceId: 'archived', operator: 'falsy' }
          }
        ]
      };

      renderContract(listElement, {
        todos: [
          { id: 't1', title: 'Active row', archived: false },
          { id: 't2', title: 'Archived row', archived: true }
        ]
      });

      expect(screen.getByText('Active row')).toBeInTheDocument();
      expect(screen.queryByText('Archived row')).not.toBeInTheDocument();
    });
  });

  describe('knob classes', () => {
    it('maps button variant and size knobs to classes without leaking attributes', () => {
      renderContract({
        id: 'save-btn',
        type: 'button',
        properties: { text: 'Save', variant: 'primary', size: 'sm' },
        dataBindings: [],
        eventBindings: []
      });

      const button = screen.getByRole('button');
      expect(button).toHaveClass('button-variant-primary', 'button-size-sm');
      expect(button).not.toHaveAttribute('variant');
      expect(button).not.toHaveAttribute('size');
    });

    it('falls back to the manifest defaults when knobs are not set', () => {
      renderContract({
        id: 'plain-btn',
        type: 'button',
        properties: { text: 'Plain' },
        dataBindings: [],
        eventBindings: []
      });

      expect(screen.getByRole('button')).toHaveClass('button-variant-default', 'button-size-md');
    });

    it('normalizes an invalid enum value to the default with a warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      renderContract({
        id: 'odd-btn',
        type: 'button',
        properties: { text: 'Odd', variant: 'sparkly' },
        dataBindings: [],
        eventBindings: []
      });

      const button = screen.getByRole('button');
      expect(button).toHaveClass('button-variant-default');
      expect(button).not.toHaveClass('button-variant-sparkly');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sparkly'));
    });

    it('maps the text role knob to a class and strips the prop', () => {
      renderContract({
        id: 'heading',
        type: 'text',
        properties: { content: 'Section heading', role: 'title' },
        dataBindings: [],
        eventBindings: []
      });

      const text = screen.getByText('Section heading');
      expect(text).toHaveClass('text-role-title');
      expect(text).not.toHaveAttribute('role');
    });

    it('maps container direction and gap knobs to classes', () => {
      const { container } = renderContract({
        id: 'box',
        type: 'container',
        properties: { direction: 'column', gap: '16' },
        dataBindings: [],
        eventBindings: []
      });

      const box = container.querySelector('[data-element-id="box"]');
      expect(box).toHaveClass('container-direction-column', 'container-gap-16');
      expect(box).not.toHaveAttribute('direction');
      expect(box).not.toHaveAttribute('gap');
    });

    it('merges knob classes with an authored className', () => {
      renderContract({
        id: 'danger-btn',
        type: 'button',
        properties: { text: 'Delete', className: 'custom-btn', variant: 'danger' },
        dataBindings: [],
        eventBindings: []
      });

      expect(screen.getByRole('button')).toHaveClass('custom-btn', 'button-variant-danger');
    });
  });

  describe('select', () => {
    const selectElement: UIElement = {
      id: 'color-select',
      type: 'select',
      properties: {},
      dataBindings: [{ property: 'options', source: 'state', sourceId: 'colors' }],
      eventBindings: []
    };

    it('renders options from an array of strings and reports changes', () => {
      const setElementValue = vi.fn();

      renderContract(selectElement, { colors: ['red', 'blue'] }, { setElementValue });

      expect(screen.getByRole('option', { name: 'red' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'blue' })).toBeInTheDocument();

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'blue' } });
      expect(setElementValue).toHaveBeenCalledWith('color-select', 'blue');
    });

    it('renders value and label option objects', () => {
      renderContract(
        selectElement,
        {
          colors: [
            { value: 's', label: 'Small' },
            { value: 'l', label: 'Large' }
          ]
        },
        { setElementValue: vi.fn() }
      );

      const option = screen.getByRole('option', { name: 'Small' }) as HTMLOptionElement;
      expect(option.value).toBe('s');
      expect(screen.getByRole('option', { name: 'Large' })).toBeInTheDocument();
    });

    it('renders the placeholder option while nothing is selected', () => {
      const withPlaceholder: UIElement = {
        ...selectElement,
        properties: { placeholder: 'Pick a color' }
      };

      renderContract(withPlaceholder, { colors: ['red', 'blue'] }, { setElementValue: vi.fn() });

      const placeholder = screen.getByRole('option', { name: 'Pick a color' });
      expect(placeholder).toBeDisabled();
      expect(screen.getByRole('combobox')).toHaveValue('');
    });

    it('omits the placeholder once a value is selected', () => {
      const withPlaceholder: UIElement = {
        ...selectElement,
        properties: { placeholder: 'Pick a color' }
      };

      renderContract(
        withPlaceholder,
        { colors: ['red', 'blue'], 'element_color-select': 'blue' },
        { setElementValue: vi.fn() }
      );

      expect(screen.queryByRole('option', { name: 'Pick a color' })).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).toHaveValue('blue');
    });
  });

  describe('checkbox', () => {
    it('auto-controls a standalone checkbox and reports boolean changes', () => {
      const setElementValue = vi.fn();
      const checkboxElement: UIElement = {
        id: 'agree',
        type: 'checkbox',
        properties: { label: 'Agree' },
        dataBindings: [],
        eventBindings: []
      };

      renderContract(checkboxElement, { element_agree: false }, { setElementValue });

      const box = screen.getByRole('checkbox');
      expect(box).not.toBeChecked();

      fireEvent.click(box);
      expect(setElementValue).toHaveBeenCalledWith('agree', true);
    });

    it('reflects the stored element state on a standalone checkbox', () => {
      const setElementValue = vi.fn();
      const checkboxElement: UIElement = {
        id: 'agree',
        type: 'checkbox',
        properties: { label: 'Agree' },
        dataBindings: [],
        eventBindings: []
      };

      renderContract(checkboxElement, { element_agree: true }, { setElementValue });

      const box = screen.getByRole('checkbox');
      expect(box).toBeChecked();

      fireEvent.click(box);
      expect(setElementValue).toHaveBeenCalledWith('agree', false);
    });

    const rowCheckboxList = (rowOverrides: Partial<UIElement> = {}): UIElement => ({
      id: 'todo-list',
      type: 'list',
      properties: {},
      dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
      eventBindings: [],
      children: [
        {
          id: 'row-check',
          type: 'checkbox',
          properties: {},
          dataBindings: [{ property: 'checked', source: 'item', sourceId: 'completed' }],
          eventBindings: [],
          ...rowOverrides
        }
      ]
    });

    it('drives in-list checkboxes from the item binding instead of element state', () => {
      const setElementValue = vi.fn();
      const todos = [
        { id: 't1', completed: true },
        { id: 't2', completed: false }
      ];

      renderContract(rowCheckboxList(), { todos }, { setElementValue });

      const boxes = screen.getAllByRole('checkbox');
      expect(boxes).toHaveLength(2);
      expect(boxes[0]).toBeChecked();
      expect(boxes[1]).not.toBeChecked();
      expect(boxes[0]).toHaveAttribute('readonly');

      fireEvent.click(boxes[0]);
      expect(setElementValue).not.toHaveBeenCalled();
    });

    it('routes in-list checkbox changes to the bound operation with the row item', () => {
      const setElementValue = vi.fn();
      const todos = [
        { id: 't1', completed: true },
        { id: 't2', completed: false }
      ];
      const listElement = rowCheckboxList({
        eventBindings: [{ event: 'change', operationId: 'op-toggle' }]
      });

      renderContract(listElement, { todos }, { setElementValue });

      fireEvent.click(screen.getAllByRole('checkbox')[1]);
      expect(mockOnOperationExecute).toHaveBeenCalledWith('op-toggle', { item: todos[1] });
      expect(setElementValue).not.toHaveBeenCalled();
    });
  });

  describe('list emptyText', () => {
    const listElement: UIElement = {
      id: 'todo-list',
      type: 'list',
      properties: { emptyText: 'No todos yet' },
      dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
      eventBindings: [],
      children: [
        {
          id: 'row-title',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
          eventBindings: []
        }
      ]
    };

    it('renders the empty marker when the bound items are empty', () => {
      const { container } = renderContract(listElement, { todos: [] });

      const empty = screen.getByText('No todos yet');
      expect(empty).toHaveClass('der-empty');
      expect(container.querySelector('ul')).toBeNull();
    });

    it('renders rows instead of the empty marker when items exist', () => {
      const { container } = renderContract(listElement, {
        todos: [{ id: 't1', title: 'First' }]
      });

      expect(container.querySelectorAll('li')).toHaveLength(1);
      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.queryByText('No todos yet')).not.toBeInTheDocument();
    });
  });

  describe('input label knob', () => {
    it('wraps the input in a label carrying the knob text', () => {
      renderContract({
        id: 'name-in',
        type: 'input',
        properties: { label: 'Name', placeholder: 'Type a name' },
        dataBindings: [],
        eventBindings: []
      });

      const input = screen.getByLabelText('Name');
      expect(input).toHaveAttribute('placeholder', 'Type a name');
      expect(input.closest('label')).toHaveClass('der-field');
    });
  });
});
