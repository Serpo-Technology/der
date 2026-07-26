/**
 * Recipes instantiate through the same validation and normalization as
 * generation: a proven contract becomes a renderable app with no model call,
 * and a contract that no longer fits the installed vocabulary is refused
 * with the validation problems.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The desktop core's checker and finalizer, served by the kernel's wasm
// build so recipes validate against the real semantics under jsdom.
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../../../test/kernel-invoke')).kernelInvoke,
}));

import { FRAGMENT_RECIPES, RecipeDef } from '../../operations/registry';
import { checkRecipe, instantiateRecipe } from '../RecipeService';

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

function installRecipe(overrides: Partial<RecipeDef> = {}): RecipeDef {
  const def: RecipeDef = {
    name: 'starter.counter',
    title: 'Click Counter',
    description: 'Counts button clicks.',
    keywords: ['counter'],
    spec: { goal: 'Count clicks', assumptions: ['Starts at zero'], openQuestions: [] },
    contract: JSON.parse(JSON.stringify(COUNTER_CONTRACT)),
    partId: 'test.starter',
    publisher: 'test-pub',
    ...overrides,
  };
  FRAGMENT_RECIPES[def.name] = def;
  return def;
}

afterEach(() => {
  for (const key of Object.keys(FRAGMENT_RECIPES)) {
    delete FRAGMENT_RECIPES[key];
  }
});

describe('RecipeService', () => {
  it('instantiates a proven contract through the generation-path normalization', async () => {
    installRecipe();

    const { contract, spec, warnings } = await instantiateRecipe('starter.counter');

    expect(contract.name).toBe('counter');
    expect(contract.operations[0].executionType).toBe('builtin');
    expect(contract.layout?.properties?.flexDirection).toBe('column');
    expect(contract.metadata?.description).toBe('Count clicks');
    expect(spec.assumptions).toEqual(['Starts at zero']);
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('does not mutate the stored recipe contract', async () => {
    const def = installRecipe();
    const before = JSON.parse(JSON.stringify(def.contract));

    await instantiateRecipe('starter.counter');

    expect(def.contract).toEqual(before);
  });

  it('refuses a recipe whose operations are not installed, naming them', async () => {
    const contract = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    contract.operations[0].operationName = 'crypto.price';
    const def = installRecipe({ contract });

    const check = await checkRecipe(def);
    expect(check.ok).toBe(false);
    expect(check.problems.join('\n')).toContain('crypto.price');

    await expect(instantiateRecipe('starter.counter')).rejects.toThrow(/crypto\.price/);
  });

  it('refuses a recipe that does not fit the contract shape', async () => {
    const def = installRecipe({ contract: { name: 'broken', elements: [] } });

    const check = await checkRecipe(def);
    expect(check.ok).toBe(false);

    await expect(instantiateRecipe('starter.counter')).rejects.toThrow(/validate/);
  });

  it('throws for a recipe that is not installed', async () => {
    await expect(instantiateRecipe('starter.missing')).rejects.toThrow(/starter\.missing/);
  });

  it('falls back to the description when a recipe carries no spec', async () => {
    installRecipe({ spec: undefined });

    const { spec } = await instantiateRecipe('starter.counter');

    expect(spec.goal).toBe('Counts button clicks.');
    expect(spec.assumptions).toEqual([]);
  });

  it('instantiates the committed starter-apps bundle against the real vocabulary', async () => {
    const bundlePath = resolve(
      __dirname,
      '../../../../fragments/dist/der-labs.starter-apps.derpart'
    );
    const envelope = JSON.parse(readFileSync(bundlePath, 'utf8'));
    const manifest = JSON.parse(Buffer.from(envelope.manifestB64, 'base64').toString('utf8'));
    for (const recipe of manifest.recipes) {
      FRAGMENT_RECIPES[recipe.name] = {
        ...recipe,
        keywords: recipe.keywords ?? [],
        partId: manifest.id,
        publisher: manifest.publisher,
      };
    }

    const def = FRAGMENT_RECIPES['apps.expense_tracker'];
    expect(await checkRecipe(def)).toEqual({ ok: true, problems: [] });

    const { contract, spec } = await instantiateRecipe('apps.expense_tracker');
    expect(contract.name).toBe('expense-tracker');
    expect(contract.operations.every((op) => op.executionType === 'builtin')).toBe(true);
    expect(spec.goal).toContain('category');
  });
});
