/**
 * The committed conformance corpus against the kernel's wasm build: the
 * same shared runner the cargo suite drives, executed inside the wasm
 * module under Node. A failure here means the wasm artifact drifted from
 * the corpus (rebuild it with scripts/build-runtime-wasm.sh) or the
 * envelope broke.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { instantiateKernel, KernelInstance } from '../../runtime-core/wasm-kernel';

const FAMILIES: Array<{ family: string; file: string }> = [
  { family: 'transform', file: 'transforms.json' },
  { family: 'pipeline', file: 'transforms.json' },
  { family: 'operation', file: 'operations.json' },
  { family: 'session', file: 'sessions.json' },
  { family: 'template', file: 'templates.json' },
  { family: 'view', file: 'views.json' },
  { family: 'validation', file: 'validation.json' },
  { family: 'streaming', file: 'streaming.json' },
  { family: 'expression', file: 'expressions.json' },
  { family: 'composePrompt', file: 'compose.json' },
  { family: 'composeResponse', file: 'compose.json' },
  { family: 'composeFinalize', file: 'compose.json' },
  { family: 'composeLoop', file: 'compose.json' },
];

let kernel: KernelInstance;

beforeAll(async () => {
  const bytes = readFileSync(join(__dirname, '../../../../runtime-wasm/dist/der_runtime_kernel.wasm'));
  kernel = await instantiateKernel(bytes);
});

describe('runtime kernel wasm build', () => {
  for (const { family, file } of FAMILIES) {
    it(`passes the ${family} vectors`, () => {
      const fixtures = JSON.parse(
        readFileSync(join(__dirname, '../../../../runtime-conformance', file), 'utf8')
      );
      const outcome = kernel.run({ operation: 'vectors.runFamily', family, fixtures }) as {
        failures: string[];
      };
      expect(outcome.failures).toEqual([]);
    });
  }

  it('runs sessions end to end over the envelope', () => {
    const contract = {
      name: 'clicker',
      elements: [
        {
          id: 'add-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add' }],
        },
        {
          id: 'shown',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'count' }],
        },
      ],
      operations: [
        {
          id: 'op-add',
          operationName: 'counter.add',
          inputs: [{ name: 'key', source: 'constant', sourceId: 'count' }],
          outputs: [],
        },
      ],
      initialState: { count: 0 },
    };
    const opened = kernel.run({
      operation: 'session.open',
      sessionId: 's-1',
      contract,
      env: { ids: [], randoms: [], epochMs: 1753315200000, tzOffsetMinutes: 0 },
    }) as { tree: unknown[]; state: Record<string, unknown> };
    expect(opened.state.count).toBe(0);

    const outcome = kernel.run({
      operation: 'session.dispatch',
      sessionId: 's-1',
      operationIds: ['op-add'],
    }) as { failed: string | null; state: Record<string, unknown> };
    expect(outcome.failed).toBeNull();
    expect(outcome.state.count).toBe(1);

    kernel.run({ operation: 'session.close', sessionId: 's-1' });
  });
});
