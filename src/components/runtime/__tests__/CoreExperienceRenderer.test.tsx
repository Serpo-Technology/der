/**
 * The thin-client renderer against a scripted core: trees in, dispatches
 * and element writes out, in user order. The fake session server plays the
 * runtime core's role so the protocol contract is what's under test.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let scripted: {
  openTree: unknown[];
  dispatchOutcomes: Array<Record<string, unknown>>;
} = { openTree: [], dispatchOutcomes: [] };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    invokeCalls.push({ cmd, args });
    if (cmd === 'runtime_open_session') {
      return { sessionId: 'sess-1', tree: scripted.openTree, state: { opened: true } };
    }
    if (cmd === 'runtime_dispatch_event') {
      return (
        scripted.dispatchOutcomes.shift() ?? {
          failed: null,
          error: null,
          tree: scripted.openTree,
          state: {},
        }
      );
    }
    if (cmd === 'runtime_resolve_view') {
      return scripted.openTree;
    }
    return null;
  },
}));

import { CoreExperienceRenderer } from '../CoreExperienceRenderer';
import { contractUsesLocalCode } from '../../../services/runtime-core/session-client';
import type { Contract } from '../../../types/contract';

const CONTRACT = {
  name: 'clicker',
  version: '1.0.0',
  elements: [],
  operations: [],
} as unknown as Contract;

function textNode(id: string, content: string) {
  return { id, type: 'text', props: { content }, events: {}, children: [] };
}

function buttonNode(id: string, label: string, opIds: string[]) {
  return {
    id,
    type: 'button',
    props: { text: label },
    events: { click: opIds },
    children: [],
  };
}

function inputNode(id: string, value: string) {
  return {
    id,
    type: 'input',
    props: { label: 'Name' },
    events: {},
    children: [],
    control: { kind: 'text', value },
  };
}

beforeEach(() => {
  invokeCalls.length = 0;
  scripted = { openTree: [], dispatchOutcomes: [] };
});

describe('CoreExperienceRenderer', () => {
  it('renders the opened tree and dispatches chains through the core', async () => {
    scripted.openTree = [
      textNode('count-text', 'Count: 0'),
      buttonNode('add-btn', 'Add', ['op-add', 'op-log']),
    ];
    scripted.dispatchOutcomes = [
      {
        failed: null,
        error: null,
        tree: [textNode('count-text', 'Count: 1'), buttonNode('add-btn', 'Add', ['op-add', 'op-log'])],
        state: { count: 1 },
      },
      {
        failed: null,
        error: null,
        tree: [textNode('count-text', 'Count: 1'), buttonNode('add-btn', 'Add', ['op-add', 'op-log'])],
        state: { count: 1 },
      },
    ];
    const states: unknown[] = [];
    render(
      <CoreExperienceRenderer
        contract={CONTRACT}
        experienceId="exp-1"
        onStateChange={(state) => states.push(state.data)}
      />
    );

    await screen.findByText('Count: 0');
    fireEvent.click(screen.getByText('Add'));
    await screen.findByText('Count: 1');

    const dispatches = invokeCalls.filter((call) => call.cmd === 'runtime_dispatch_event');
    // One core call per chain entry, in contract order.
    expect(dispatches.map((call) => call.args.operationIds)).toEqual([['op-add'], ['op-log']]);
    expect(states.at(-1)).toEqual({ count: 1 });
  });

  it('stops the chain at a failure and shows the core error', async () => {
    scripted.openTree = [buttonNode('go-btn', 'Go', ['op-a', 'op-b'])];
    scripted.dispatchOutcomes = [
      {
        failed: 'op-a',
        error: 'The recipient address is not valid: nobody',
        tree: scripted.openTree,
        state: {},
      },
    ];
    render(<CoreExperienceRenderer contract={CONTRACT} experienceId="exp-1" />);

    fireEvent.click(await screen.findByText('Go'));
    await screen.findByText('The recipient address is not valid: nobody');

    const dispatches = invokeCalls.filter((call) => call.cmd === 'runtime_dispatch_event');
    expect(dispatches).toHaveLength(1);
  });

  it('sends element writes and keeps the local value over the echo', async () => {
    scripted.openTree = [inputNode('name-in', '')];
    render(<CoreExperienceRenderer contract={CONTRACT} experienceId="exp-1" />);

    const input = (await screen.findByLabelText('Name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ada' } });

    expect(input.value).toBe('Ada');
    await waitFor(() => {
      const sets = invokeCalls.filter((call) => call.cmd === 'runtime_set_element');
      expect(sets).toHaveLength(1);
      expect(sets[0].args).toMatchObject({ elementId: 'name-in', value: 'Ada' });
    });
    // The echoed tree still carries the stale empty value; the local write
    // must win until a dispatch outcome replaces it.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Ada');
  });

  it('detects the local-code escape hatch', () => {
    expect(contractUsesLocalCode(CONTRACT)).toBe(false);
    expect(
      contractUsesLocalCode({
        ...CONTRACT,
        operations: [
          {
            id: 'op-x',
            operationName: 'custom',
            executionType: 'local',
            implementation: { type: 'local', code: 'return {}' },
            inputs: [],
            outputs: [],
            triggers: [],
          },
        ],
      } as unknown as Contract)
    ).toBe(true);
  });
});
