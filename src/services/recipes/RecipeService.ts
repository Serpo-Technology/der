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
import { LlmContractSchema, checkAgainstManifests, formatZodError } from '../../schemas/contract';
import type { ContractShape } from '../../schemas/contract';
import { ContractBuilder } from '../ai-interpreter/contract-builder';
import { RecipeDef, getRecipeDef } from '../operations/registry';
import { repositoryService } from '../repository/repository-service';

export interface RecipeCheck {
  ok: boolean;
  problems: string[];
}

export interface InstantiatedRecipe {
  contract: Contract;
  spec: ComposedSpec;
  warnings: ValidationWarning[];
}

/** The stored contract is shared registry state and validation seeds state
 * keys in place, so every use works on its own copy. */
function cloneContract(def: RecipeDef): unknown {
  return JSON.parse(JSON.stringify(def.contract));
}

function validateShape(def: RecipeDef): {
  shape?: ContractShape;
  problems: string[];
  warnings: ValidationWarning[];
} {
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
  const { problems } = validateShape(def);
  return { ok: problems.length === 0, problems };
}

/** Turns an installed recipe into a renderable contract without a model
 * call, through the same validation and normalization as generation. */
export function instantiateRecipe(name: string): InstantiatedRecipe {
  const def = getRecipeDef(name);
  if (!def) {
    throw new Error(`No installed recipe named "${name}"`);
  }
  const { shape, problems, warnings } = validateShape(def);
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
  const builder = new ContractBuilder(repositoryService);
  const contract = builder.finalizeShape(shape, spec.goal);
  return { contract, spec, warnings };
}
