/**
 * Partial-experience packs: fragments that ship operations. Covers the
 * per-instance operation expansion, validation parity (pack operations run
 * through the same manifest rules, and pack state writes satisfy outer
 * readers), and an end-to-end render of the committed stopwatch pack.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render, fireEvent, act, cleanup } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { FRAGMENT_ELEMENTS, UiFragmentDef } from '../../operations/registry';
import { expandPackOperations } from '../ui-fragments';
import { checkAgainstManifests, ContractSchema } from '../../../schemas/contract';
import type { ContractShape } from '../../../schemas/contract';
import { DynamicExperienceRenderer } from '../../../components/runtime/DynamicExperienceRenderer';
import type { Contract, UIElement } from '../../../types/contract';

function loadStopwatchDef(): UiFragmentDef {
  const bundlePath = resolve(__dirname, '../../../../fragments/dist/der-labs.ui-basics.derpart');
  const envelope = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const manifest = JSON.parse(Buffer.from(envelope.manifestB64, 'base64').toString('utf8'));
  const fragment = manifest.uiFragments.find(
    (entry: { name: string }) => entry.name === 'basics.stopwatch'
  );
  return {
    name: fragment.name,
    description: fragment.description,
    howto: fragment.howto,
    params: fragment.params ?? [],
    template: fragment.template,
    operations: fragment.operations,
  };
}

const stopwatchDef = loadStopwatchDef();

beforeAll(() => {
  FRAGMENT_ELEMENTS['basics.stopwatch'] = stopwatchDef;
});

afterAll(() => {
  delete FRAGMENT_ELEMENTS['basics.stopwatch'];
});

function parseShape(raw: Record<string, unknown>): ContractShape {
  return JSON.parse(JSON.stringify(ContractSchema.parse(raw))) as ContractShape;
}

describe('expandPackOperations', () => {
  it('instantiates {{id}}-scoped operations per instance, including nested ones', () => {
    const elements = [
      { id: 'sw', type: 'basics.stopwatch' },
      {
        id: 'wrap',
        type: 'container',
        children: [{ id: 'sw2', type: 'basics.stopwatch' }],
      },
    ] as unknown as UIElement[];

    const packs = expandPackOperations(elements);

    expect(packs).toHaveLength(8);
    const ids = packs.map((pack) => pack.operation.id);
    expect(ids).toContain('sw-advance');
    expect(ids).toContain('sw2-advance');
    const advance = packs.find((pack) => pack.operation.id === 'sw-advance')!;
    expect(advance.operation.operationName).toBe('counter.add');
    expect(advance.operation.inputs[0].sourceId).toBe('sw-elapsed');
    expect(advance.operation.outputs).toEqual([]);
    expect(advance.fragmentType).toBe('basics.stopwatch');
    expect(advance.path).toBe('elements.0');
    const nested = packs.find((pack) => pack.operation.id === 'sw2-advance')!;
    expect(nested.path).toBe('elements.1.children.0');
  });

  it('drops any implementation from pack operation templates', () => {
    FRAGMENT_ELEMENTS['basics.sneaky'] = {
      name: 'basics.sneaky',
      description: 'test double',
      params: [],
      template: { id: '{{id}}-box', type: 'container' },
      operations: [
        {
          id: '{{id}}-call',
          operationName: 'state.set',
          implementation: { type: 'remote', endpoint: 'https://example.com' },
          inputs: [{ name: 'key', source: 'constant', sourceId: '{{id}}-x' }],
        },
      ],
    };
    try {
      const packs = expandPackOperations([
        { id: 'a', type: 'basics.sneaky' },
      ] as unknown as UIElement[]);
      expect(packs[0].operation.implementation).toBeUndefined();
    } finally {
      delete FRAGMENT_ELEMENTS['basics.sneaky'];
    }
  });
});

describe('pack validation parity', () => {
  it('accepts a contract that is only a pack instance', () => {
    const shape = parseShape({
      name: 'timer-app',
      elements: [{ id: 'sw', type: 'basics.stopwatch', properties: { label: 'Reading' } }],
      operations: [],
    });

    const result = checkAgainstManifests(shape);

    expect(result.errors).toEqual([]);
  });

  it('lets outer bindings read pack state without seed warnings', () => {
    const shape = parseShape({
      name: 'timer-app',
      elements: [
        { id: 'sw', type: 'basics.stopwatch' },
        {
          id: 'note',
          type: 'text',
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'sw-elapsed',
              transforms: [
                { type: 'format', parameters: { template: 'Elapsed: {{value}}' } },
              ],
            },
          ],
        },
      ],
      operations: [],
    });

    const result = checkAgainstManifests(shape);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(shape.initialState?.['sw-elapsed']).toBeUndefined();
  });

  it('fails a pack whose vocabulary is gone, naming the instance', () => {
    FRAGMENT_ELEMENTS['basics.stale'] = {
      name: 'basics.stale',
      description: 'test double',
      params: [],
      template: {
        id: '{{id}}-box',
        type: 'container',
        children: [
          {
            id: '{{id}}-btn',
            type: 'button',
            properties: { text: 'Go' },
            eventBindings: [{ event: 'click', operationId: '{{id}}-go' }],
          },
        ],
      },
      operations: [{ id: '{{id}}-go', operationName: 'gone.op', inputs: [] }],
    };
    try {
      const shape = parseShape({
        name: 'stale-app',
        elements: [{ id: 'w', type: 'basics.stale' }],
        operations: [],
      });

      const result = checkAgainstManifests(shape);

      const hit = result.errors.find((error) => error.message.includes('gone.op'));
      expect(hit).toBeDefined();
      expect(hit!.path).toContain('basics.stale');
    } finally {
      delete FRAGMENT_ELEMENTS['basics.stale'];
    }
  });
});

describe('stopwatch pack end to end', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('starts, ticks, stops, and resets with no contract operations', async () => {
    vi.useFakeTimers();
    const contract = {
      name: 'reading-timer',
      version: '1.0.0',
      elements: [
        {
          id: 'sw',
          type: 'basics.stopwatch',
          properties: { label: 'Reading' },
          dataBindings: [],
          eventBindings: [],
        },
      ],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0',
      },
    } as unknown as Contract;

    const { getByText, queryByText } = render(
      <DynamicExperienceRenderer contract={contract} experienceId="pack-test" />
    );
    await act(async () => {});

    fireEvent.click(getByText('Start'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getByText('3 s')).toBeTruthy();

    fireEvent.click(getByText('Stop'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getByText('3 s')).toBeTruthy();
    expect(queryByText('5 s')).toBeNull();

    fireEvent.click(getByText('Reset'));
    await act(async () => {});
    expect(getByText('0 s')).toBeTruthy();
  });
});
