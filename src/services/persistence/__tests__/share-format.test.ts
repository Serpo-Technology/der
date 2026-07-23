/**
 * The import boundary: pasted bytes hydrate into a real ShareableContract
 * (dates become Date instances) and the embedded contract passes the same
 * vocabulary gate as a recipe, so imports either open as working apps or
 * fail naming their problems.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { finalizeSharedContract, parseShareableText } from '../share-format';

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

function envelope(overrides: Record<string, unknown> = {}): string {
  // JSON round trip: dates arrive as strings, exactly like a real paste.
  return JSON.stringify({
    contract: COUNTER_CONTRACT,
    metadata: {
      title: 'Click Counter',
      createdAt: '2026-07-20T10:00:00.000Z',
      sharedAt: '2026-07-21T10:00:00.000Z',
    },
    version: '1.0.0',
    checksum: 'abc123',
    ...overrides,
  });
}

describe('parseShareableText', () => {
  it('hydrates string dates into Date instances and validates the contract', () => {
    const parsed = parseShareableText(envelope());

    expect(parsed.problems).toEqual([]);
    expect(parsed.shareable?.metadata.createdAt).toBeInstanceOf(Date);
    expect(parsed.shareable?.metadata.sharedAt).toBeInstanceOf(Date);
    expect(parsed.shareable?.metadata.title).toBe('Click Counter');
    expect(parsed.shape?.name).toBe('counter');
  });

  it('imports a bare contract paste with default details and a note', () => {
    const parsed = parseShareableText(JSON.stringify(COUNTER_CONTRACT));

    expect(parsed.problems).toEqual([]);
    expect(parsed.shareable?.metadata.title).toBe('Shared experience');
    expect(parsed.warnings.join(' ')).toContain('bare app contract');
  });

  it('reports unparseable text instead of throwing', () => {
    const parsed = parseShareableText('not json at all');

    expect(parsed.shareable).toBeUndefined();
    expect(parsed.problems[0]).toContain('not valid JSON');
  });

  it('rejects a share whose operations are not installed, naming them', () => {
    const contract = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    contract.operations[0].operationName = 'wizardry.cast';
    const parsed = parseShareableText(envelope({ contract }));

    expect(parsed.shape).toBeUndefined();
    expect(parsed.problems.join('\n')).toContain('wizardry.cast');
    // The hydrated envelope still previews so the person sees WHAT failed.
    expect(parsed.shareable?.metadata.title).toBe('Click Counter');
  });

  it('rejects code-carrying operations outright', () => {
    const contract = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    contract.operations[0].implementation = { type: 'local', code: 'alert(1)' };
    const parsed = parseShareableText(envelope({ contract }));

    expect(parsed.shape).toBeUndefined();
    expect(parsed.problems.length).toBeGreaterThan(0);
  });

  it('notes a missing checksum without blocking the import', () => {
    const raw = JSON.parse(envelope());
    delete raw.checksum;
    const parsed = parseShareableText(JSON.stringify(raw));

    expect(parsed.problems).toEqual([]);
    expect(parsed.warnings.join(' ')).toContain('checksum');
  });
});

describe('finalizeSharedContract', () => {
  it('normalizes a valid share like the generation path', () => {
    const parsed = parseShareableText(envelope());
    const contract = finalizeSharedContract(parsed);

    expect(contract.operations[0].executionType).toBe('builtin');
    expect(contract.layout?.properties?.flexDirection).toBe('column');
  });

  it('refuses to finalize a share with problems', () => {
    const contract = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    contract.operations[0].operationName = 'wizardry.cast';
    const parsed = parseShareableText(envelope({ contract }));

    expect(() => finalizeSharedContract(parsed)).toThrow(/wizardry\.cast/);
  });
});
