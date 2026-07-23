/**
 * Registry client: the index passes through the Rust resolver and a
 * registry install downloads then stages through the normal trust flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'fetch_registry_index') {
      return {
        formatVersion: 1,
        parts: [
          {
            id: 'der-labs.expr-evaluate',
            name: 'Expressions',
            version: '1.1.0',
            publisher: 'der-labs',
            namespace: 'expr',
            description: 'x',
            operations: ['expr.evaluate'],
            bundleUrl: 'https://example.com/reg/der-labs.expr-evaluate.derpart'
          }
        ]
      };
    }
    if (cmd === 'download_registry_bundle') return 'QUJD';
    if (cmd === 'stage_fragment') {
      return { stagingToken: 't', fingerprint: 'f', name: 'Expressions', version: '1.1.0', publisher: 'der-labs', capabilities: [], warnings: [] };
    }
    throw new Error(`unexpected command ${cmd}`);
  })
}));

import { fragmentsService } from '../FragmentsService';

describe('registry client', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('fetches and returns the resolved index', async () => {
    const index = await fragmentsService.fetchRegistryIndex('https://example.com/reg/index.json');
    expect(index.parts[0].id).toBe('der-labs.expr-evaluate');
    expect(calls[0]).toMatchObject({
      cmd: 'fetch_registry_index',
      args: { url: 'https://example.com/reg/index.json' }
    });
  });

  it('stages a registry bundle through the normal trust flow', async () => {
    const summary = await fragmentsService.stageFromRegistry(
      'https://example.com/reg/der-labs.expr-evaluate.derpart'
    );
    expect(summary.name).toBe('Expressions');
    expect(calls.map((c) => c.cmd)).toEqual(['download_registry_bundle', 'stage_fragment']);
    expect(calls[1].args).toMatchObject({ bundleB64: 'QUJD' });
  });
});
