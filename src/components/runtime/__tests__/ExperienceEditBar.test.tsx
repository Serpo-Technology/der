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

  it('renders warnings with a dismiss control', () => {
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
});
