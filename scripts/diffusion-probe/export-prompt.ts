/**
 * Writes the exact create-mode prompt DER would send for a description, for
 * probing models outside the app (e.g. llama.cpp's diffusion example).
 *
 *   npx tsx scripts/diffusion-probe/export-prompt.ts "a todo list app" > prompt.txt
 *   npx tsx scripts/diffusion-probe/export-prompt.ts --split /tmp "a todo list app"
 *   npx tsx scripts/diffusion-probe/export-prompt.ts --compact --split /tmp "a todo list app"
 *
 * --split writes der-system.txt and der-user.txt into the given directory,
 * for runners that take the system prompt separately (llama.cpp -sysf).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractBuilder } from '../../src/services/ai-interpreter/contract-builder';
import { repositoryService } from '../../src/services/repository/repository-service';
import { registerBuiltins } from '../../src/services/repository/builtins';

// The repository layer logs fallback noise outside Tauri; keep output clean.
console.warn = () => {};
console.error = () => {};

const args = process.argv.slice(2);
let splitDir: string | null = null;
const splitIndex = args.indexOf('--split');
if (splitIndex !== -1) {
  splitDir = args[splitIndex + 1] ?? '.';
  args.splice(splitIndex, 2);
}
let compact = false;
const compactIndex = args.indexOf('--compact');
if (compactIndex !== -1) {
  compact = true;
  args.splice(compactIndex, 1);
}
const description = args.join(' ').trim() ||
  'Create a todo list app with add, delete, and mark complete functionality';

async function main() {
  await registerBuiltins(repositoryService);
  const builder = new ContractBuilder(repositoryService);
  const { system, user } = await builder.renderCreatePrompt(description, { compact });
  if (splitDir) {
    const systemPath = join(splitDir, 'der-system.txt');
    const userPath = join(splitDir, 'der-user.txt');
    writeFileSync(systemPath, system);
    writeFileSync(userPath, user);
    process.stdout.write(`${systemPath}\n${userPath}\n`);
    return;
  }
  process.stdout.write(`${system}\n\n${user}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
