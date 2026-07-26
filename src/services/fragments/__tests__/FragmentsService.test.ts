/**
 * Installed parts join the shared operation registry and execute through the
 * wasm host command with typed errors mapped to readable messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { FragmentsService } from '../FragmentsService';
import {
  FRAGMENT_OPERATIONS,
  FRAGMENT_RECIPES,
  getOperationDef,
  BUILTIN_OPERATIONS,
} from '../../operations/registry';

const invokeMock = vi.mocked(invoke);

const INSTALLED = [
  {
    manifest: {
      id: 'der-labs.stats-summary',
      name: 'Statistics',
      version: '1.0.0',
      publisher: 'der-labs',
      description: 'Statistics over number arrays',
      namespace: 'stats',
      operations: [
        {
          name: 'stats.summary',
          description: 'Count, sum, mean, min, max of numbers',
          inputs: [{ name: 'values', type: 'array', required: true }],
          outputs: [{ name: 'mean', type: 'number' }],
          howto: 'Bind values from a state array.',
        },
      ],
    },
    fingerprint: 'abc123',
    fingerprintGrouped: 'abc1 23',
  },
];

describe('FragmentsService', () => {
  let service: FragmentsService;

  beforeEach(() => {
    invokeMock.mockReset();
    service = new FragmentsService();
  });

  it('publishes installed part operations into the shared registry', async () => {
    invokeMock.mockResolvedValueOnce(INSTALLED);

    await service.init();

    expect(FRAGMENT_OPERATIONS['stats.summary']).toBeDefined();
    expect(getOperationDef('stats.summary')?.description).toContain('mean');
    // Builtins stay authoritative.
    expect(getOperationDef('list.append')).toBe(BUILTIN_OPERATIONS['list.append']);
  });

  it('clears operations for removed parts on re-init', async () => {
    invokeMock.mockResolvedValueOnce(INSTALLED);
    await service.init();
    expect(FRAGMENT_OPERATIONS['stats.summary']).toBeDefined();

    invokeMock.mockResolvedValueOnce([]);
    await service.init();
    expect(FRAGMENT_OPERATIONS['stats.summary']).toBeUndefined();
  });

  it('publishes and clears recipes with their owning part', async () => {
    const withRecipes = [
      {
        manifest: {
          id: 'test.starter',
          name: 'Starter Apps',
          version: '1.0.0',
          publisher: 'test-pub',
          description: 'Proven apps ready to open.',
          namespace: 'starter',
          operations: [],
          recipes: [
            {
              name: 'starter.counter',
              title: 'Click Counter',
              description: 'Counts button clicks.',
              keywords: ['counter'],
              contract: { name: 'counter', elements: [{ id: 'a', type: 'text' }] },
            },
          ],
        },
        fingerprint: 'abc123',
        fingerprintGrouped: 'abc1 23',
      },
    ];
    invokeMock.mockResolvedValueOnce(withRecipes);
    await service.init();

    expect(FRAGMENT_RECIPES['starter.counter']).toMatchObject({
      title: 'Click Counter',
      partId: 'test.starter',
      publisher: 'test-pub',
    });

    invokeMock.mockResolvedValueOnce([]);
    await service.init();
    expect(FRAGMENT_RECIPES['starter.counter']).toBeUndefined();
  });

  it('never shadows a builtin operation', async () => {
    const hostile = JSON.parse(JSON.stringify(INSTALLED));
    hostile[0].manifest.operations[0].name = 'list.append';
    invokeMock.mockResolvedValueOnce(hostile);

    await service.init();

    expect(getOperationDef('list.append')).toBe(BUILTIN_OPERATIONS['list.append']);
  });

  it('publishes the manifest surface only; execution lives in the runtime core', async () => {
    invokeMock.mockResolvedValueOnce(INSTALLED);
    await service.init();

    const def = FRAGMENT_OPERATIONS['stats.summary'];
    expect(def.inputs.map((input) => input.name)).toEqual(['values']);
    expect(def.outputs.map((output) => output.name)).toEqual(['mean']);
    expect('execute' in def).toBe(false);
  });

  it('treats an unavailable backend as no installed parts', async () => {
    invokeMock.mockRejectedValueOnce(new Error('no tauri'));

    await service.init();

    expect(service.getInstalled()).toEqual([]);
  });
});
