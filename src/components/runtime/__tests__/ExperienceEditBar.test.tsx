import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ExperienceEditBar } from '../ExperienceEditBar';

describe('ExperienceEditBar', () => {
  it('submits the trimmed instruction and clears the field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ExperienceEditBar onSubmit={onSubmit} busy={false} />);

    const input = screen.getByLabelText('Describe a change');
    fireEvent.change(input, { target: { value: '  add a chart  ' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('add a chart'));
    expect(input).toHaveValue('');
  });

  it('disables the controls while busy and shows progress text', () => {
    render(<ExperienceEditBar onSubmit={vi.fn()} busy={true} />);

    expect(screen.getByLabelText('Describe a change')).toBeDisabled();
    expect(screen.getByText('Updating...')).toBeDisabled();
  });

  it('shows the error when the change fails and keeps the instruction', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('The model returned garbage'));
    render(<ExperienceEditBar onSubmit={onSubmit} busy={false} />);

    const input = screen.getByLabelText('Describe a change');
    fireEvent.change(input, { target: { value: 'break things' } });
    fireEvent.click(screen.getByText('Apply'));

    expect(await screen.findByText('The model returned garbage')).toBeInTheDocument();
    expect(input).toHaveValue('break things');
  });

  it('renders a single warning inline with a dismiss control', () => {
    const onDismiss = vi.fn();
    render(
      <ExperienceEditBar
        onSubmit={vi.fn()}
        busy={false}
        warnings={[{ path: 'elements', message: 'Edit removed element "old-chart"', code: 'EDIT_REMOVED_PART' }]}
        onDismissWarnings={onDismiss}
      />
    );

    expect(screen.getByText('Edit removed element "old-chart"')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('labels a lone assumption with its kind', () => {
    render(
      <ExperienceEditBar
        onSubmit={vi.fn()}
        busy={false}
        warnings={[{ path: 'spec', message: 'Amounts are stored without a currency', code: 'SPEC_ASSUMPTION' }]}
      />
    );

    expect(screen.getByText('Assumed: Amounts are stored without a currency')).toBeInTheDocument();
  });

  it('groups multiple notes by kind with the messages listed', () => {
    render(
      <ExperienceEditBar
        onSubmit={vi.fn()}
        busy={false}
        warnings={[
          { path: 'elements.0.properties.size', message: '"huge" is not one of sm|md|lg; using "md"', code: 'MANIFEST_ADJUSTED' },
          { path: 'spec', message: 'Amounts are stored without a currency', code: 'SPEC_ASSUMPTION' },
          { path: 'spec', message: 'Categories are free text', code: 'SPEC_ASSUMPTION' },
          { path: 'spec', message: 'Should totals reset monthly?', code: 'SPEC_QUESTION' }
        ]}
      />
    );

    // Summary line counts each kind separately.
    expect(screen.getByText('1 adjustment, 2 assumptions, 1 open question')).toBeInTheDocument();

    // Expanding shows the grouped messages.
    expect(screen.getByText('Adjustments')).toBeInTheDocument();
    expect(screen.getByText('Assumptions')).toBeInTheDocument();
    expect(screen.getByText('Open questions')).toBeInTheDocument();
    expect(screen.getByText('"huge" is not one of sm|md|lg; using "md"')).toBeInTheDocument();
    expect(screen.getByText('Categories are free text')).toBeInTheDocument();
    expect(screen.getByText('Should totals reset monthly?')).toBeInTheDocument();
  });
});
