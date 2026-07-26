/**
 * Recipes: full experiences shipped by signed parts as declarative contracts.
 * Instantiation revalidates against the installed part vocabulary and runs
 * the same normalization as generation, so a recipe app carries exactly the
 * guarantees of a freshly composed one. A recipe whose contract no longer
 * validates (a part it uses is not installed, or a wiring rule tightened)
 * fails with the validation problems instead of rendering a broken app.
 */

import { ComposedSpec } from '../../types/blueprint';
import { Contract, ValidationWarning } from '../../types/contract';
import { invoke } from '@tauri-apps/api/core';
import { getRecipeDef } from '../operations/registry';
import { resolveRecipeShape } from './recipe-check';

export { checkRecipe } from './recipe-check';
export type { RecipeCheck } from './recipe-check';

export interface InstantiatedRecipe {
  contract: Contract;
  spec: ComposedSpec;
  warnings: ValidationWarning[];
}

/** Turns an installed recipe into a renderable contract without a model
 * call, through the same validation and normalization as generation. */
export async function instantiateRecipe(name: string): Promise<InstantiatedRecipe> {
  const def = getRecipeDef(name);
  if (!def) {
    throw new Error(`No installed recipe named "${name}"`);
  }
  const { shape, problems, warnings } = await resolveRecipeShape(def);
  if (!shape || problems.length > 0) {
    throw new Error(
      `Recipe "${def.title}" does not validate against the installed parts:\n${problems.join('\n')}`
    );
  }
  const spec: ComposedSpec = {
    goal: def.spec?.goal ?? def.description,
    assumptions: def.spec?.assumptions ?? [],
    openQuestions: def.spec?.openQuestions ?? [],
  };
  const contract = (await invoke('runtime_finalize_contract', {
    shape,
    description: spec.goal,
  })) as Contract;
  return { contract, spec, warnings };
}
