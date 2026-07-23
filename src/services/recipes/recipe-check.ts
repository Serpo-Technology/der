/**
 * Pure validation of installed recipes against the current part vocabulary.
 * Kept free of pipeline imports so the contract builder can consult it while
 * composing; instantiation (which needs the builder) lives in RecipeService.
 */

import { ValidationWarning } from '../../types/contract';
import { LlmContractSchema, checkAgainstManifests, formatZodError } from '../../schemas/contract';
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

export function resolveRecipeShape(def: RecipeDef): ResolvedRecipeShape {
  const parsed = LlmContractSchema.safeParse(cloneContract(def));
  if (!parsed.success) {
    return { problems: [formatZodError(parsed.error)], warnings: [] };
  }
  const shape = parsed.data as ContractShape;
  const result = checkAgainstManifests(shape);
  return {
    shape,
    problems: result.errors.map((error) => `${error.path}: ${error.message}`),
    warnings: result.warnings,
  };
}

/** Validates a recipe's contract against the current part vocabulary. */
export function checkRecipe(def: RecipeDef): RecipeCheck {
  const { problems } = resolveRecipeShape(def);
  return { ok: problems.length === 0, problems };
}
