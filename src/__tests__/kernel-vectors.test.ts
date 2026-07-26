/**
 * The committed kernel artifact must implement the committed conformance
 * corpus: every vector family runs through runtime-wasm/dist. A failure here
 * usually means runtime-core changed without a wasm rebuild
 * (scripts/build-runtime-wasm.sh) or the corpus was edited by hand.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { instantiateKernel, KernelInstance } from '../services/runtime-core/wasm-kernel';

const ROOT = resolve(__dirname, '../..');

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

describe('kernel wasm build against the conformance corpus', () => {
  let kernel: KernelInstance;

  beforeAll(async () => {
    kernel = await instantiateKernel(
      readFileSync(resolve(ROOT, 'runtime-wasm/dist/der_runtime_kernel.wasm'))
    );
  });

  it.each(FAMILIES)('$family vectors pass', ({ family, file }) => {
    const fixtures = JSON.parse(
      readFileSync(resolve(ROOT, 'runtime-conformance', file), 'utf8')
    );
    const outcome = kernel.run({ operation: 'vectors.runFamily', family, fixtures }) as {
      failures: string[];
    };
    expect(outcome.failures).toEqual([]);
  });
});
