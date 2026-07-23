/**
 * Judges a model's raw output with the real pipeline rules: JSON extraction,
 * composed-response schema parse, and the manifest check. Prints the verdict
 * the repair round would have seen.
 *
 *   npx tsx scripts/diffusion-probe/validate.ts output.txt
 */

import { readFileSync } from 'node:fs';
import { extractJson } from '../../src/services/ai-interpreter/llm-json';
import {
  ComposedResponseSchema,
  checkAgainstManifests,
  formatManifestErrors,
  formatZodError,
} from '../../src/schemas/contract';
import type { ContractShape } from '../../src/schemas/contract';
import { repositoryService } from '../../src/services/repository/repository-service';
import { registerBuiltins } from '../../src/services/repository/builtins';
import { loadDistParts } from './load-parts';

console.warn = () => {};
console.error = () => {};

async function main() {
  const args = process.argv.slice(2);
  const partsIndex = args.indexOf('--with-parts');
  if (partsIndex !== -1) {
    loadDistParts('fragments/dist');
    args.splice(partsIndex, 1);
  }
  const file = args[0];
  if (!file) {
    console.error('Usage: npx tsx scripts/diffusion-probe/validate.ts [--with-parts] <model-output-file>');
    process.exit(2);
  }
  await registerBuiltins(repositoryService);

  const raw = readFileSync(file, 'utf8');
  let candidate: unknown;
  try {
    candidate = JSON.parse(extractJson(raw));
  } catch (error) {
    console.log('VERDICT: unparseable JSON');
    console.log(String(error));
    process.exit(1);
  }

  const parsed = ComposedResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    console.log('VERDICT: schema failure');
    console.log(formatZodError(parsed.error));
    process.exit(1);
  }

  const result = checkAgainstManifests(parsed.data.contract as ContractShape);
  if (result.errors.length > 0) {
    console.log('VERDICT: manifest errors (repair round would fire)');
    console.log(formatManifestErrors(result.errors));
    process.exit(1);
  }

  console.log('VERDICT: PASS');
  if (result.warnings.length > 0) {
    console.log('Adjustments:');
    for (const warning of result.warnings) {
      console.log(`- ${warning.path}: ${warning.message}`);
    }
  }
  const spec = parsed.data.spec;
  if (spec.assumptions.length > 0) console.log('Assumptions:', spec.assumptions.join(' | '));
  console.log(
    `Contract: ${parsed.data.contract.elements.length} top-level elements, ${parsed.data.contract.operations.length} operations`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
