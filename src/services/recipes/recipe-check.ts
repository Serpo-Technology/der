/**
 * Pure validation of installed recipes against the current part vocabulary.
 * Kept free of pipeline imports so the contract builder can consult it while
 * composing; instantiation (which needs the builder) lives in RecipeService.
 */

import { ValidationWarning } from '../../types/contract';
import { invoke } from '@tauri-apps/api/core';
import type { ContractShape } from '../../schemas/contract';
import { RecipeDef } from '../operations/registry';

export interface RecipeCheck {
  ok: boolean;
  problems: string[];
}

export interface ResolvedRecipeShape {
  shape?: ContractShape;
  problems: string[];
  warnings: ValidationWarning[];
}

/** The stored contract is shared registry state and validation seeds state
 * keys in place, so every use works on its own copy. */
function cloneContract(def: RecipeDef): unknown {
  return JSON.parse(JSON.stringify(def.contract));
}

export async function resolveRecipeShape(def: RecipeDef): Promise<ResolvedRecipeShape> {
  // The runtime core runs the same structural and manifest gates the model
  // faces; the webview carries no checker of its own.
  const verdict = (await invoke('runtime_check_contract', { contract: cloneContract(def) })) as {
    shape: ContractShape | null;
    errors: string[];
    warnings: string[];
  };
  if (!verdict.shape || verdict.errors.length > 0) {
    return { problems: verdict.errors, warnings: [] };
  }
  return {
    shape: verdict.shape,
    problems: [],
    warnings: verdict.warnings.map((message) => ({ path: '', message, code: 'MANIFEST_ADJUSTED' })),
  };
}

/** Validates a recipe's contract against the current part vocabulary. */
export async function checkRecipe(def: RecipeDef): Promise<RecipeCheck> {
  const { problems } = await resolveRecipeShape(def);
  return { ok: problems.length === 0, problems };
}
