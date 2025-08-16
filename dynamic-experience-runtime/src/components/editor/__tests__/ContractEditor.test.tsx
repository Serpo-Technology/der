/**
 * ContractEditor Component Tests
 * Requirements: 5.2, 5.5, 10.3, 10.7
 */

// React import removed - not needed in test files with modern React
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContractEditor } from '../ContractEditor';
import { Contract } from '../../../models/contract';
// Unused imports removed

// Mock CSS import
vi.mock('../ContractEditor.css', () => ({}));

describe('ContractEditor', () => {
  let mockContract: Contract;
  let mockOnChange: ReturnType<typeof vi.fn>;
  let mockOnValidationChange: ReturnType<typeof vi.fn>;
  let mockOnRegenerateSection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create a test contract
    mockContract = new Contract({
      name: 'Test Contract',
      version: '1.0.0',
      elements: [
        {
          id: 'element1',
          type: 'button',
          properties: { text: 'Click me' },
          dataBindings: [],
          eventBindings: []
        }
      ],
      operations: [
        {
          id: 'operation1',
          operationName: 'test_operation',
          inputs: [],
          outputs: [],
          triggers: []
        }
      ],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0'
      }
    });

    mockOnChange = vi.fn();
    mockOnValidationChange = vi.fn();
    mockOnRegenerateSection = vi.fn();
  });

  it('renders contract editor with visual mode by default', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    expect(screen.getByText('Contract Editor')).toBeInTheDocument();
    expect(screen.getByText('Visual Editor')).toHaveClass('active');
    expect(screen.getByText('JSON Editor')).not.toHaveClass('active');
  });

  it('displays contract summary information', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    expect(screen.getByText('Contract Summary')).toBeInTheDocument();
    expect(screen.getByText('Test Contract')).toBeInTheDocument();
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Elements:')).toBeInTheDocument();
    expect(screen.getByText('Operations:')).toBeInTheDocument();
  });

  it('switches between visual and JSON editing modes', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    const jsonButton = screen.getByText('JSON Editor');
    fireEvent.click(jsonButton);

    await waitFor(() => {
      expect(jsonButton).toHaveClass('active');
      expect(screen.getByText('Visual Editor')).not.toHaveClass('active');
    });
  });

  it('displays validation results', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
        onValidationChange={mockOnValidationChange}
      />
    );

    expect(screen.getByText('✓ Contract is valid')).toBeInTheDocument();
  });

  it('shows sections list with elements and operations', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    expect(screen.getByText('Sections')).toBeInTheDocument();
    expect(screen.getByText('Element: element1 (button)')).toBeInTheDocument();
    expect(screen.getByText('Operation: operation1 (test_operation)')).toBeInTheDocument();
    expect(screen.getByText('Contract Metadata')).toBeInTheDocument();
    expect(screen.getByText('Layout Configuration')).toBeInTheDocument();
    expect(screen.getByText('Styling Configuration')).toBeInTheDocument();
  });

  it('allows selecting and editing sections', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    const elementSection = screen.getByText('Element: element1 (button)');
    fireEvent.click(elementSection);

    await waitFor(() => {
      expect(screen.getByText('Element: element1')).toBeInTheDocument();
      expect(screen.getByDisplayValue('element1')).toBeInTheDocument();
      expect(screen.getByDisplayValue('button')).toBeInTheDocument();
    });
  });

  it('enables adding new elements when not read-only', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    const addElementButton = screen.getByText('+ Add Element');
    expect(addElementButton).toBeInTheDocument();

    fireEvent.click(addElementButton);
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('enables adding new operations when not read-only', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    const addOperationButton = screen.getByText('+ Add Operation');
    expect(addOperationButton).toBeInTheDocument();

    fireEvent.click(addOperationButton);
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('hides add controls when read-only', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
        readOnly={true}
      />
    );

    expect(screen.queryByText('+ Add Element')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add Operation')).not.toBeInTheDocument();
  });

  it('shows regenerate buttons when selective regeneration is enabled', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
        enableSelectiveRegeneration={true}
        onRegenerateSection={mockOnRegenerateSection}
      />
    );

    const regenerateButtons = screen.getAllByTitle('Regenerate this section');
    expect(regenerateButtons.length).toBeGreaterThan(0);

    fireEvent.click(regenerateButtons[0]);
    expect(mockOnRegenerateSection).toHaveBeenCalled();
  });

  it('calls onValidationChange when validation changes', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
        onValidationChange={mockOnValidationChange}
      />
    );

    await waitFor(() => {
      expect(mockOnValidationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          isValid: expect.any(Boolean),
          errors: expect.any(Array),
          warnings: expect.any(Array)
        })
      );
    });
  });

  it('handles element editing', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select element section
    const elementSection = screen.getByText('Element: element1 (button)');
    fireEvent.click(elementSection);

    await waitFor(() => {
      const idInput = screen.getByDisplayValue('element1');
      fireEvent.change(idInput, { target: { value: 'new_element_id' } });
    });

    expect(mockOnChange).toHaveBeenCalled();
  });

  it('handles operation editing', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select operation section
    const operationSection = screen.getByText('Operation: operation1 (test_operation)');
    fireEvent.click(operationSection);

    await waitFor(() => {
      const nameInput = screen.getByDisplayValue('test_operation');
      fireEvent.change(nameInput, { target: { value: 'new_operation_name' } });
    });

    expect(mockOnChange).toHaveBeenCalled();
  });

  it('handles metadata editing', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select metadata section
    const metadataSection = screen.getByText('Contract Metadata');
    fireEvent.click(metadataSection);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Contract')).toBeInTheDocument();
      expect(screen.getByLabelText('Name:')).toBeInTheDocument();
    });
  });

  it('handles layout editing', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select layout section
    const layoutSection = screen.getByText('Layout Configuration');
    fireEvent.click(layoutSection);

    await waitFor(() => {
      expect(screen.getByLabelText('Layout Type:')).toBeInTheDocument();
      expect(screen.getByText('Flex')).toBeInTheDocument();
    });
  });

  it('handles styling editing', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select styling section
    const stylingSection = screen.getByText('Styling Configuration');
    fireEvent.click(stylingSection);

    await waitFor(() => {
      expect(screen.getByLabelText('Theme:')).toBeInTheDocument();
      expect(screen.getByText('Default')).toBeInTheDocument();
    });
  });

  it('displays validation errors when contract is invalid', async () => {
    // Create an invalid contract with circular references
    const invalidContract = new Contract({
      name: 'Invalid Contract',
      version: '1.0.0',
      elements: [
        {
          id: 'element1',
          type: 'button',
          properties: {},
          dataBindings: [
            {
              property: 'text',
              source: 'operation',
              sourceId: 'nonexistent_operation'
            }
          ],
          eventBindings: []
        }
      ],
      operations: []
    });

    render(
      <ContractEditor
        contract={invalidContract}
        onChange={mockOnChange}
      />
    );

    // Wait for validation to complete
    await waitFor(() => {
      expect(screen.queryByText('✓ Contract is valid')).not.toBeInTheDocument();
    });
  });

  it('tracks contract edits', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select element section and make an edit
    const elementSection = screen.getByText('Element: element1 (button)');
    fireEvent.click(elementSection);

    await waitFor(() => {
      const typeInput = screen.getByDisplayValue('button');
      fireEvent.change(typeInput, { target: { value: 'input' } });
    });

    expect(mockOnChange).toHaveBeenCalledWith(
      expect.any(Contract),
      expect.objectContaining({
        elementEdits: expect.objectContaining({
          element1: expect.objectContaining({
            type: 'input'
          })
        })
      })
    );
  });

  it('handles element removal', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select element section
    const elementSection = screen.getByText('Element: element1 (button)');
    fireEvent.click(elementSection);

    await waitFor(() => {
      const removeButton = screen.getByText('Remove');
      fireEvent.click(removeButton);
    });

    expect(mockOnChange).toHaveBeenCalled();
  });

  it('handles operation removal', async () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
      />
    );

    // Select operation section
    const operationSection = screen.getByText('Operation: operation1 (test_operation)');
    fireEvent.click(operationSection);

    await waitFor(() => {
      const removeButton = screen.getByText('Remove');
      fireEvent.click(removeButton);
    });

    expect(mockOnChange).toHaveBeenCalled();
  });

  it('disables editing when read-only', () => {
    render(
      <ContractEditor
        contract={mockContract}
        onChange={mockOnChange}
        readOnly={true}
      />
    );

    // Select element section
    const elementSection = screen.getByText('Element: element1 (button)');
    fireEvent.click(elementSection);

    // Remove button should not be present
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  });
});