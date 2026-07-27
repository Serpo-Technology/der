/**
 * The eval harness's session backend: the runtime kernel's wasm build,
 * fresh per scenario, with dispatches routed to the same machinery the
 * TS-runtime path used: real compute-part wasm, the scenario's remote
 * stubs, and the synchronous platform stubs. Behavioral runs therefore
 * execute exactly the semantics the desktop core ships.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  instantiateKernel,
  KernelInstance,
  KernelRequest,
} from '../../src/services/runtime-core/wasm-kernel';
import type {
  EventOutcome,
  SessionOpened,
  SessionTransport,
} from '../../src/services/runtime-core/session-client';
import type { ResolvedNode } from '../../src/services/runtime-view/resolve-view';
import { FRAGMENT_DEFS, PART_ROUTES, remoteStub } from './register-parts';
import { assembleStructured, getOperationDef } from '../../src/services/operations/registry';
import { runGuestSync } from './wasm-host';
import { syncPlatformCall } from './file-stubs';

const KERNEL_PATH = join(__dirname, '../../runtime-wasm/dist/der_runtime_kernel.wasm');
let kernelBytes: Buffer | null = null;

interface DispatchPayload {
  operationId: string;
  operationName: string;
  inputs: Record<string, unknown>;
  implementation?: Record<string, unknown> | null;
}

function hostCall(request: KernelRequest): { ok?: unknown; err?: string } {
  try {
    switch (request.operation) {
      case 'env.id':
        return { ok: randomUUID() };
      case 'env.random':
        return { ok: Math.random() };
      case 'env.now':
        return { ok: Date.now() };
      case 'env.tzOffset':
        return { ok: -new Date().getTimezoneOffset() };
      case 'dispatch': {
        const payload = request.request as DispatchPayload;
        const name = payload.operationName;
        if (name === 'http.get') {
          // Scenario stubs for http.get are keyed by url, so navigation
          // steps can serve different pages.
          const table = remoteStub(name) ?? {};
          const url = String(payload.inputs.url ?? '');
          const page = (table as Record<string, unknown>)[url];
          if (!page) {
            return { err: `Scenario has no http.get stub for ${url || '(empty url)'}` };
          }
          return { ok: page };
        }
        const route = PART_ROUTES.get(name);
        if (route?.remote) {
          const stub = remoteStub(name);
          if (!stub) {
            return { err: `Scenario has no stub for remote operation ${name}` };
          }
          return { ok: stub };
        }
        if (route?.module) {
          const assembled = assembleStructured(payload.inputs, route.structuredPrefixes);
          return { ok: runGuestSync(route.module, name, assembled) };
        }
        const def = getOperationDef(name);
        const assembledInputs = assembleStructured(payload.inputs, def?.structuredPrefixes);
        return { ok: syncPlatformCall(name, assembledInputs) };
      }
      default:
        return { err: `Unknown host operation ${String(request.operation)}` };
    }
  } catch (error) {
    return { err: error instanceof Error ? error.message : String(error) };
  }
}

/** A fresh kernel per scenario keeps sessions and memory isolated. */
export async function createKernelTransport(): Promise<SessionTransport> {
  if (!kernelBytes) {
    kernelBytes = readFileSync(KERNEL_PATH);
  }
  const kernel: KernelInstance = await instantiateKernel(kernelBytes, { call: hostCall });
  let counter = 0;

  return {
    async open(contract, initialData, experienceId) {
      const sessionId = `eval-${experienceId}-${counter++}`;
      const reply = kernel.run({
        operation: 'session.open',
        sessionId,
        contract,
        initialData,
        fragmentDefs: FRAGMENT_DEFS,
      }) as { tree: ResolvedNode[]; state: Record<string, unknown> };
      return { sessionId, tree: reply.tree, state: reply.state } as SessionOpened;
    },
    async setElement(sessionId, elementId, value) {
      const reply = kernel.run({
        operation: 'session.setElement',
        sessionId,
        elementId,
        value,
      }) as { tree: ResolvedNode[] };
      return reply.tree;
    },
    async dispatch(sessionId, operationIds, item) {
      return kernel.run({
        operation: 'session.dispatch',
        sessionId,
        operationIds,
        item,
      }) as EventOutcome;
    },
    async close(sessionId) {
      kernel.run({ operation: 'session.close', sessionId });
    },
  };
}
