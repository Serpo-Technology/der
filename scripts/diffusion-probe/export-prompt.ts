/**
 * Writes the exact create-mode prompt DER would send for a description, for
 * probing models outside the app (e.g. llama.cpp's diffusion example).
 *
 *   npx tsx scripts/diffusion-probe/export-prompt.ts "a todo list app" > prompt.txt
 */

import { ContractBuilder } from '../../src/services/ai-interpreter/contract-builder';
import { repositoryService } from '../../src/services/repository/repository-service';
import { registerBuiltins } from '../../src/services/repository/builtins';

// The repository layer logs fallback noise outside Tauri; keep output clean.
console.warn = () => {};
console.error = () => {};

const description = process.argv.slice(2).join(' ').trim() ||
  'Create a todo list app with add, delete, and mark complete functionality';

async function main() {
  await registerBuiltins(repositoryService);
  const builder = new ContractBuilder(repositoryService);
  const { system, user } = await builder.renderCreatePrompt(description);
  process.stdout.write(`${system}\n\n${user}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
