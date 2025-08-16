/**
 * Blueprint Editor Tests
 * Requirements: 5.1, 10.2, 10.3
 */

// React import removed - not needed in test files with modern React
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BlueprintEditor } from '../BlueprintEditor';
import { Blueprint } from '../../../types/blueprint';

const mockBlueprint: Blueprint = {
  description: 'A simple todo application',
  goal: 'Create a task management system',
  requiredCapabilities: ['data-storage', 'user-interface'],
  uiElements: [
    {
      type: 'input',
      purpose: 'Task input field',
      capabilities: ['text-input'],
      properties: { placeholder: 'Enter task...' }
    }
  ],
  operations: [
    {
      name: 'addTask',
      purpose: 'Add a new task',
      inputs: ['taskText'],
      outputs: ['taskId'],
      executionType: 'local'
    }
  ],
  ambiguities: []
};

describe('BlueprintEditor', () => {
  it('renders blueprint editor with form mode by default', () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    expect(screen.getByText('Blueprint Editor')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A simple todo application')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Create a task management system')).toBeInTheDocument();
  });

  it('allows editing description and triggers change callback', async () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    const descriptionInput = screen.getByDisplayValue('A simple todo application');
    fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalled();
      const calledBlueprint = mockOnChange.mock.calls[0][0];
      expect(calledBlueprint.description).toBe('Updated description');
      expect(calledBlueprint.userModifications).toHaveLength(1);
    });
  });

  it('allows editing goal and triggers change callback', async () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    const goalInput = screen.getByDisplayValue('Create a task management system');
    fireEvent.change(goalInput, { target: { value: 'Updated goal' } });

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalled();
      const calledBlueprint = mockOnChange.mock.calls[0][0];
      expect(calledBlueprint.goal).toBe('Updated goal');
    });
  });

  it('allows adding capabilities', async () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    const capabilityInput = screen.getByPlaceholderText('Add capability...');
    const addButton = screen.getByText('Add');

    fireEvent.change(capabilityInput, { target: { value: 'new-capability' } });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalled();
      const calledBlueprint = mockOnChange.mock.calls[0][0];
      expect(calledBlueprint.requiredCapabilities).toContain('new-capability');
    });
  });

  it('allows removing capabilities', async () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    // Find the remove button for the first capability
    const removeButtons = screen.getAllByText('×');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalled();
      const calledBlueprint = mockOnChange.mock.calls[0][0];
      expect(calledBlueprint.requiredCapabilities).not.toContain('data-storage');
    });
  });

  it('switches to JSON mode when toggle is clicked', () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    const jsonModeButton = screen.getByText('JSON Mode');
    fireEvent.click(jsonModeButton);

    expect(screen.getByText('JSON Editor (blueprint)')).toBeInTheDocument();
    expect(screen.getByText('Form Mode')).toBeInTheDocument();
  });

  it('shows preview when preview toggle is clicked', () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    const previewButton = screen.getByText('Show Preview');
    fireEvent.click(previewButton);

    expect(screen.getByText('Blueprint Preview')).toBeInTheDocument();
    expect(screen.getByText('Hide Preview')).toBeInTheDocument();
  });

  it('validates blueprint and shows validation results', async () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    const invalidBlueprint: Blueprint = {
      ...mockBlueprint,
      description: '', // Invalid - empty description
      goal: ''         // Invalid - empty goal
    };

    render(
      <BlueprintEditor
        blueprint={invalidBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    await waitFor(() => {
      expect(mockOnValidation).toHaveBeenCalled();
      const validation = mockOnValidation.mock.calls[0][0];
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e: any) => e.message === 'Description is required')).toBe(true);
      expect(validation.errors.some((e: any) => e.message === 'Goal is required')).toBe(true);
    });
  });

  it('respects readOnly prop', () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
        readOnly={true}
      />
    );

    const descriptionInput = screen.getByDisplayValue('A simple todo application');
    expect(descriptionInput).toHaveAttribute('readonly');

    const goalInput = screen.getByDisplayValue('Create a task management system');
    expect(goalInput).toHaveAttribute('readonly');
  });

  it('tracks user modifications with timestamps', async () => {
    const mockOnChange = vi.fn();
    const mockOnValidation = vi.fn();

    render(
      <BlueprintEditor
        blueprint={mockBlueprint}
        onBlueprintChange={mockOnChange}
        onValidationChange={mockOnValidation}
      />
    );

    const descriptionInput = screen.getByDisplayValue('A simple todo application');
    fireEvent.change(descriptionInput, { target: { value: 'Modified description' } });

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalled();
      const calledBlueprint = mockOnChange.mock.calls[0][0];
      expect(calledBlueprint.userModifications).toHaveLength(1);
      
      const modification = calledBlueprint.userModifications[0];
      expect(modification.location).toBe('description');
      expect(modification.originalValue).toBe('A simple todo application');
      expect(modification.newValue).toBe('Modified description');
      expect(modification.preserved).toBe(true);
      expect(modification.timestamp).toBeInstanceOf(Date);
    });
  });
});