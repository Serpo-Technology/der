/**
 * Saved per-app state (initialData) merges over the contract's seeds when a
 * window reopens.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { DynamicExperienceRenderer } from '../DynamicExperienceRenderer';
import { Contract } from '../../../types/contract';

function contractWithNote(): Contract {
  return {
    name: 'note-app',
    version: '1.0.0',
    initialState: { note: 'seeded note' },
    elements: [
      {
        id: 'note-view',
        type: 'text',
        properties: {},
        dataBindings: [{ property: 'content', source: 'state', sourceId: 'note' }],
        eventBindings: []
      },
      {
        id: 'note-in',
        type: 'input',
        properties: { placeholder: 'Type here' },
        dataBindings: [],
        eventBindings: []
      }
    ],
    operations: [],
    layout: { type: 'flex', properties: {} },
    styling: { theme: 'default' },
    metadata: {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0'
    }
  };
}

describe('per-app state rehydration', () => {
  it('renders contract seeds when no saved state is provided', async () => {
    render(
      <DynamicExperienceRenderer contract={contractWithNote()} experienceId="exp-1" />
    );

    expect(await screen.findByText('seeded note')).toBeInTheDocument();
  });

  it('merges saved data over the contract seeds', async () => {
    render(
      <DynamicExperienceRenderer
        contract={contractWithNote()}
        experienceId="exp-1"
        initialData={{ note: 'restored note', 'element_note-in': 'draft text' }}
      />
    );

    expect(await screen.findByText('restored note')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type here')).toHaveValue('draft text');
  });

  it('keeps seeds for keys the saved data does not carry', async () => {
    render(
      <DynamicExperienceRenderer
        contract={contractWithNote()}
        experienceId="exp-1"
        initialData={{ 'element_note-in': 'only the draft' }}
      />
    );

    expect(await screen.findByText('seeded note')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type here')).toHaveValue('only the draft');
  });
});
