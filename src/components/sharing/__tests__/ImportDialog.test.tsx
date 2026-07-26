/**
 * The import dialog must never take the window down: pasted data (whose
 * dates are strings after the JSON round trip) validates and previews
 * without a render crash, and a share that cannot open here shows its
 * problems with the import blocked.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';

// Validation runs in the desktop core; the kernel's wasm build serves it here.
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../../../test/kernel-invoke')).kernelInvoke,
}));

import { ImportDialog } from '../ImportDialog';

const COUNTER_CONTRACT = {
  name: 'counter',
  version: '1.0.0',
  elements: [
    {
      id: 'count-text',
      type: 'text',
      dataBindings: [{ property: 'content', source: 'state', sourceId: 'clicks' }],
    },
    {
      id: 'click-btn',
      type: 'button',
      properties: { text: 'Click' },
      eventBindings: [{ event: 'click', operationId: 'op-add' }],
    },
  ],
  operations: [
    {
      id: 'op-add',
      operationName: 'counter.add',
      inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }],
    },
  ],
};

function shareJson(contract: unknown = COUNTER_CONTRACT): string {
  return JSON.stringify({
    contract,
    metadata: {
      title: 'Click Counter',
      createdAt: '2026-07-20T10:00:00.000Z',
      sharedAt: '2026-07-21T10:00:00.000Z',
    },
    version: '1.0.0',
    checksum: 'abc123',
  });
}

async function openAndValidate(data: string, onError = vi.fn()) {
  render(
    <ImportDialog isOpen={true} onClose={() => undefined} onError={onError} />
  );
  fireEvent.change(screen.getByLabelText('Shared Experience Data'), {
    target: { value: data },
  });
  fireEvent.click(screen.getByText('Validate & Preview'));
  // Validation is asynchronous now; both outcomes land on the same step.
  await screen.findByText(/Ready to import|This share cannot open here/);
  return onError;
}

describe('ImportDialog', () => {
  it('accepts the app\'s own export format (null options, snake_case dates)', async () => {
    const rustWire = JSON.stringify({
      contract: COUNTER_CONTRACT,
      metadata: {
        title: 'My Counter',
        description: null,
        author: null,
        created_at: '2026-07-20T10:00:00.000000+00:00',
        shared_at: '2026-07-23T09:30:00.000000+00:00',
        tags: null,
        category: null,
      },
      version: '1.0.0',
      checksum: '1a2b3c',
    });
    await openAndValidate(rustWire);

    expect(screen.getByText('Ready to import')).toBeInTheDocument();
    expect(screen.getByText('My Counter')).toBeInTheDocument();
    expect(screen.getByText('Import Experience')).toBeEnabled();
  });

  it('previews a pasted share with string dates without crashing', async () => {
    await openAndValidate(shareJson());

    expect(screen.getByText('Ready to import')).toBeInTheDocument();
    expect(screen.getByText('Click Counter')).toBeInTheDocument();
    // Hydrated dates render; the raw ISO strings do not.
    expect(screen.queryByText(/2026-07-20T10:00:00/)).not.toBeInTheDocument();
    expect(screen.getByText('Import Experience')).toBeEnabled();
  });

  it('shows the problems and blocks import for a share that cannot open here', async () => {
    const contract = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    contract.operations[0].operationName = 'wizardry.cast';
    await openAndValidate(shareJson(contract));

    expect(screen.getByText('This share cannot open here')).toBeInTheDocument();
    expect(screen.getByText(/wizardry\.cast/)).toBeInTheDocument();
    expect(screen.getByText('Import Experience')).toBeDisabled();
  });

  it('reports unparseable data as a problem instead of crashing', async () => {
    await openAndValidate('{{{');

    // Parsing problems show on the validation step like any other problem.
    expect(screen.getByText('This share cannot open here')).toBeInTheDocument();
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    expect(screen.queryByText('Import Experience')).toBeDisabled();
  });
});
