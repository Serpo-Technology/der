/**
 * Behavioral evals: render each generated contract from the newest eval
 * results (or EVAL_RESULTS=<path>) and run its prompt's scripted
 * interactions. Static validation proves a contract is well formed; these
 * prove the wiring works when someone actually uses the app.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { CoreExperienceRenderer } from '../src/components/runtime/CoreExperienceRenderer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instantiateKernel, KernelInstance } from '../src/services/runtime-core/wasm-kernel';
import { kernelVocabulary } from './harness/register-parts';
import { setSessionTransport } from '../src/services/runtime-core/session-client';
import { createKernelTransport } from './harness/kernel-transport';
import { registerRunnableParts, setRemoteStubs } from './harness/register-parts';
import { runScenario, BehaviorScenario } from './harness/engine';
import { setupFileStubs } from './harness/file-stubs';

interface StoredResult {
  id: string;
  verdict: string;
  contract?: unknown;
}

function newestResultsPath(): string {
  const fromEnv = process.env.EVAL_RESULTS;
  if (fromEnv) return fromEnv;
  const files = readdirSync('evals')
    .filter((f) => /^results-.*\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error('No evals/results-*.json found; run npm run eval first');
  }
  return `evals/${files[files.length - 1]}`;
}

const resultsPath = newestResultsPath();
const stored = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
  label: string;
  results: StoredResult[];
};
const prompts = JSON.parse(readFileSync('evals/prompts.json', 'utf8')) as {
  prompts: Array<{ id: string; behavior?: BehaviorScenario }>;
};
const scenarios = new Map(
  prompts.prompts.filter((p) => p.behavior).map((p) => [p.id, p.behavior as BehaviorScenario])
);

registerRunnableParts('fragments/dist');

// Stored shapes normalize through the kernel's finalize, the same
// normalization the app applies before rendering.
let finalizeKernel: KernelInstance;
async function finalizeShape(shape: unknown): Promise<unknown> {
  if (!finalizeKernel) {
    finalizeKernel = await instantiateKernel(
      readFileSync(join(__dirname, '../runtime-wasm/dist/der_runtime_kernel.wasm'))
    );
  }
  return (
    finalizeKernel.run({
      operation: 'capture.finalize',
      ...kernelVocabulary(),
      shape,
      nowIso: new Date().toISOString(),
    }) as { contract: unknown }
  ).contract;
}

describe(`behavior against ${resultsPath}`, () => {
  for (const entry of stored.results) {
    const scenario = scenarios.get(entry.id);
    if (!scenario) continue;
    if (entry.verdict !== 'pass' || !entry.contract) {
      // Title stays the bare id so the eval runner can map outcomes back.
      it.skip(entry.id, () => {});
      continue;
    }
    it(entry.id, async () => {
      setRemoteStubs(scenario.stubs ?? {});
      setupFileStubs(scenario.file);
      // Contracts execute in the runtime kernel's wasm build, the same
      // semantics the desktop core ships; React stays the presentation.
      setSessionTransport(await createKernelTransport());
      const contract = (await finalizeShape(entry.contract)) as never;
      const { container, unmount } = render(
        <CoreExperienceRenderer contract={contract} experienceId={`behave-${entry.id}`} />
      );
      try {
        await runScenario(scenario, container as HTMLElement);
      } finally {
        unmount();
        setSessionTransport(undefined);
      }
      expect(true).toBe(true);
    });
  }
});
