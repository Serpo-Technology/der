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
import { DynamicExperienceRenderer } from '../src/components/runtime/DynamicExperienceRenderer';
import { ContractBuilder } from '../src/services/ai-interpreter/contract-builder';
import { repositoryService } from '../src/services/repository/repository-service';
import { ContractShape } from '../src/schemas/contract';
import { registerRunnableParts, setRemoteStubs } from './harness/register-parts';
import { runScenario, BehaviorScenario } from './harness/engine';

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
const builder = new ContractBuilder(repositoryService);

describe(`behavior against ${resultsPath}`, () => {
  for (const entry of stored.results) {
    const scenario = scenarios.get(entry.id);
    if (!scenario) continue;
    if (entry.verdict !== 'pass' || !entry.contract) {
      it.skip(`${entry.id} (no passing contract in this run)`, () => {});
      continue;
    }
    it(entry.id, async () => {
      setRemoteStubs(scenario.stubs ?? {});
      const contract = builder.finalizeShape(entry.contract as ContractShape);
      const { container, unmount } = render(
        <DynamicExperienceRenderer contract={contract} experienceId={`behave-${entry.id}`} />
      );
      try {
        await runScenario(scenario, container as HTMLElement);
      } finally {
        unmount();
      }
      expect(true).toBe(true);
    });
  }
});
