/**
 * Several bindings on one event run in contract order; a failed operation
 * stops the rest of the chain so the root error is the one the user sees.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { DynamicExperienceRenderer } from '../DynamicExperienceRenderer';
import { Contract, OperationBinding } from '../../../types/contract';

function setOp(id: string, key: string, value: string): OperationBinding {
  return {
    id,
    operationName: 'state.set',
    executionType: 'builtin',
    inputs: [
      { name: 'key', source: 'constant', sourceId: key },
      { name: 'value', source: 'constant', sourceId: value }
    ],
    outputs: [],
    triggers: []
  };
}

function chainContract(operations: OperationBinding[], bindingIds: string[]): Contract {
  return {
    name: 'chain-app',
    version: '1.0.0',
    elements: [
      {
        id: 'run-btn',
        type: 'button',
        properties: { text: 'Run' },
        dataBindings: [],
        eventBindings: bindingIds.map(operationId => ({ event: 'click', operationId }))
      },
      {
        id: 'first-view',
        type: 'text',
        properties: {},
        dataBindings: [{ property: 'content', source: 'state', sourceId: 'first' }],
        eventBindings: []
      },
      {
        id: 'second-view',
        type: 'text',
        properties: {},
        dataBindings: [{ property: 'content', source: 'state', sourceId: 'second' }],
        eventBindings: []
      }
    ],
    operations,
    layout: { type: 'flex', properties: {} },
    styling: { theme: 'default' },
    metadata: { createdAt: new Date(), updatedAt: new Date(), version: '1.0.0' }
  };
}

describe('event binding chains', () => {
  it('runs every binding of the event in contract order', async () => {
    const contract = chainContract(
      [setOp('op-first', 'first', 'first ran'), setOp('op-second', 'second', 'second ran')],
      ['op-first', 'op-second']
    );
    render(<DynamicExperienceRenderer contract={contract} experienceId="exp-chain-ok" />);

    fireEvent.click(await screen.findByText('Run'));

    expect(await screen.findByText('first ran')).toBeInTheDocument();
    expect(await screen.findByText('second ran')).toBeInTheDocument();
  });

  it('stops the chain when an operation fails', async () => {
    const broken: OperationBinding = {
      id: 'op-broken',
      operationName: 'no.such.part',
      executionType: 'builtin',
      inputs: [],
      outputs: [],
      triggers: []
    };
    const contract = chainContract(
      [broken, setOp('op-after', 'second', 'second ran')],
      ['op-broken', 'op-after']
    );
    render(<DynamicExperienceRenderer contract={contract} experienceId="exp-chain-stop" />);

    fireEvent.click(await screen.findByText('Run'));

    await waitFor(() => {
      expect(screen.getByText(/no\.such\.part/)).toBeInTheDocument();
    });
    expect(screen.queryByText('second ran')).not.toBeInTheDocument();
  });
});
