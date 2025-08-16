/**
 * ConflictResolutionDialog Component Tests
 * Requirements: 5.6, 10.4, 10.5, 10.6
 */

// React import removed - not needed in test files with modern React
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictResolutionDialog } from '../ConflictResolutionDialog';
import { EditingConflict } from '../../../interfaces/experience-editor';

// Mock CSS import
vi.mock('../ConflictResolutionDialog.css', () => ({}));

describe('ConflictResolutionDialog', () => {
    let mockConflicts: EditingConflict[];
    let mockOnResolve: ReturnType<typeof vi.fn>;
    let mockOnCancel: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockConflicts = [
            {
                type: 'ai-user-conflict',
                location: 'contract.name',
                aiSuggestion: 'AI Generated Name',
                userEdit: 'User Modified Name',
                resolutionOptions: [
                    {
                        id: 'keep-user',
                        description: 'Keep your changes',
                        action: 'keep-user',
                        preview: 'User Modified Name'
                    },
                    {
                        id: 'keep-ai',
                        description: 'Accept AI suggestion',
                        action: 'keep-ai',
                        preview: 'AI Generated Name'
                    },
                    {
                        id: 'custom',
                        description: 'Provide custom value',
                        action: 'custom'
                    }
                ]
            },
            {
                type: 'dependency-conflict',
                location: 'elements[0].dataBindings',
                aiSuggestion: [],
                userEdit: [{ source: 'operation', sourceId: 'missing_op' }],
                resolutionOptions: [
                    {
                        id: 'fix-dependency',
                        description: 'Fix dependency automatically',
                        action: 'keep-ai'
                    },
                    {
                        id: 'keep-user-fix-manually',
                        description: 'Keep user edit and fix manually',
                        action: 'keep-user'
                    }
                ]
            }
        ];

        mockOnResolve = vi.fn();
        mockOnCancel = vi.fn();
    });

    it('renders when open', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getByText('Resolve Editing Conflicts')).toBeInTheDocument();
        expect(screen.getByText(/2 conflicts? found/)).toBeInTheDocument();
    });

    it('does not render when closed', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={false}
            />
        );

        expect(screen.queryByText('Resolve Editing Conflicts')).not.toBeInTheDocument();
    });

    it('displays conflict information', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getByText('Conflict #1: contract.name')).toBeInTheDocument();
        expect(screen.getByText('Conflict #2: elements[0].dataBindings')).toBeInTheDocument();
        expect(screen.getByText('AI suggestion conflicts with your changes')).toBeInTheDocument();
        expect(screen.getByText('Changes create dependency issues')).toBeInTheDocument();
    });

    it('shows conflict type icons', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        // Check for conflict type icons (emojis)
        expect(screen.getByText('⚡')).toBeInTheDocument(); // ai-user-conflict
        expect(screen.getByText('🔗')).toBeInTheDocument(); // dependency-conflict
    });

    it('toggles conflict details', async () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        const showDetailsButton = screen.getAllByText('Show Details')[0];
        fireEvent.click(showDetailsButton);

        await waitFor(() => {
            expect(screen.getByText('AI Suggestion:')).toBeInTheDocument();
            expect(screen.getByText('Your Changes:')).toBeInTheDocument();
        });

        const hideDetailsButton = screen.getByText('Hide Details');
        fireEvent.click(hideDetailsButton);

        await waitFor(() => {
            expect(screen.queryByText('AI Suggestion:')).not.toBeInTheDocument();
        });
    });

    it('displays resolution options', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getByText('Keep your changes')).toBeInTheDocument();
        expect(screen.getByText('Accept AI suggestion')).toBeInTheDocument();
        expect(screen.getByText('Provide custom value')).toBeInTheDocument();
    });

    it('allows selecting resolution options', async () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        const keepUserOption = screen.getByLabelText('Keep your changes');
        fireEvent.click(keepUserOption);

        expect(keepUserOption).toBeChecked();
    });

    it('shows custom value input when custom option selected', async () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        const customOption = screen.getByLabelText('Provide custom value');
        fireEvent.click(customOption);

        await waitFor(() => {
            expect(screen.getByText('Custom Value:')).toBeInTheDocument();
            expect(screen.getByPlaceholderText('Enter custom value (JSON format)')).toBeInTheDocument();
        });
    });

    it('handles custom value input', async () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        const customOption = screen.getByLabelText('Provide custom value');
        fireEvent.click(customOption);

        await waitFor(() => {
            const customInput = screen.getByPlaceholderText('Enter custom value (JSON format)');
            fireEvent.change(customInput, { target: { value: '"Custom Name"' } });
            expect(customInput).toHaveValue('"Custom Name"');
        });
    });

    it('calls onCancel when cancel button clicked', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        const cancelButton = screen.getByText('Cancel');
        fireEvent.click(cancelButton);

        expect(mockOnCancel).toHaveBeenCalled();
    });

    it('calls onResolve with resolutions when resolve button clicked', async () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        // Select resolution for first conflict
        const keepUserOption = screen.getByLabelText('Keep your changes');
        fireEvent.click(keepUserOption);

        // Select resolution for second conflict
        const fixDependencyOption = screen.getByLabelText('Fix dependency automatically');
        fireEvent.click(fixDependencyOption);

        const resolveButton = screen.getByText('Resolve All Conflicts');
        fireEvent.click(resolveButton);

        expect(mockOnResolve).toHaveBeenCalledWith([
            {
                conflictId: 'contract.name',
                selectedOption: 'keep-user'
            },
            {
                conflictId: 'elements[0].dataBindings',
                selectedOption: 'fix-dependency'
            }
        ]);
    });

    it('uses default resolution when no option selected', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        const resolveButton = screen.getByText('Resolve All Conflicts');
        fireEvent.click(resolveButton);

        expect(mockOnResolve).toHaveBeenCalledWith([
            {
                conflictId: 'contract.name',
                selectedOption: 'keep-user'
            },
            {
                conflictId: 'elements[0].dataBindings',
                selectedOption: 'keep-user'
            }
        ]);
    });

    it('includes custom value in resolution when custom option selected', async () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        // Select custom option
        const customOption = screen.getByLabelText('Provide custom value');
        fireEvent.click(customOption);

        // Enter custom value
        await waitFor(() => {
            const customInput = screen.getByPlaceholderText('Enter custom value (JSON format)');
            fireEvent.change(customInput, { target: { value: '"Custom Name"' } });
        });

        const resolveButton = screen.getByText('Resolve All Conflicts');
        fireEvent.click(resolveButton);

        expect(mockOnResolve).toHaveBeenCalledWith([
            {
                conflictId: 'contract.name',
                selectedOption: 'custom',
                customValue: 'Custom Name'
            },
            {
                conflictId: 'elements[0].dataBindings',
                selectedOption: 'keep-user'
            }
        ]);
    });

    it('displays option previews when available', () => {
        render(
            <ConflictResolutionDialog
                conflicts={mockConflicts}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getAllByText('Preview:')[0]).toBeInTheDocument();
        expect(screen.getByText('"User Modified Name"')).toBeInTheDocument();
    });

    it('handles empty conflicts array', () => {
        render(
            <ConflictResolutionDialog
                conflicts={[]}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getByText(/0 conflicts? found/)).toBeInTheDocument();
    });

    it('handles single conflict', () => {
        render(
            <ConflictResolutionDialog
                conflicts={[mockConflicts[0]]}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getByText(/1 conflicts? found/)).toBeInTheDocument();
    });

    it('displays validation conflict type correctly', () => {
        const validationConflict: EditingConflict = {
            type: 'validation-conflict',
            location: 'contract.version',
            aiSuggestion: '2.0.0',
            userEdit: 'invalid-version',
            resolutionOptions: [
                {
                    id: 'fix-validation',
                    description: 'Fix validation error automatically',
                    action: 'keep-ai'
                }
            ]
        };

        render(
            <ConflictResolutionDialog
                conflicts={[validationConflict]}
                onResolve={mockOnResolve}
                onCancel={mockOnCancel}
                isOpen={true}
            />
        );

        expect(screen.getByText('⚠️')).toBeInTheDocument(); // validation-conflict icon
        expect(screen.getByText('Changes cause validation errors')).toBeInTheDocument();
    });
});