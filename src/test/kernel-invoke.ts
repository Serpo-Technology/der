/**
 * Test helper: routes the runtime core's contract commands to the kernel's
 * wasm build, so suites that validate or finalize contracts under jsdom
 * exercise the real checker instead of a canned stub.
 *
 * Use inside a `vi.mock('@tauri-apps/api/core', ...)` factory:
 *
 *   vi.mock('@tauri-apps/api/core', async () => ({
 *     invoke: (await import('../../test/kernel-invoke')).kernelInvoke,
 *   }));
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instantiateKernel, KernelInstance } from '../services/runtime-core/wasm-kernel';

let kernelPromise: Promise<KernelInstance> | null = null;

function kernel(): Promise<KernelInstance> {
  if (!kernelPromise) {
    kernelPromise = instantiateKernel(
      readFileSync(join(__dirname, '../../runtime-wasm/dist/der_runtime_kernel.wasm'))
    );
  }
  return kernelPromise;
}

export async function kernelInvoke(
  command: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const instance = await kernel();
  switch (command) {
    case 'runtime_check_contract':
      // Same human checker the command wraps: structural schema, manifest
      // gate, "path: message" string verdicts, mutated shape when clean.
      return instance.run({
        operation: 'contract.check',
        contract: args.contract,
        fragmentDefs: {},
        partOperations: {},
        credentials: [],
        recipes: {},
      });
    case 'runtime_finalize_contract': {
      const reply = instance.run({
        operation: 'capture.finalize',
        fragmentDefs: {},
        partOperations: {},
        credentials: [],
        recipes: {},
        shape: args.shape,
        ...(args.description !== undefined ? { description: args.description } : {}),
        nowIso: new Date().toISOString(),
      }) as { contract: unknown };
      return reply.contract;
    }
    default:
      throw new Error(`kernel-invoke has no route for ${command}`);
  }
}
