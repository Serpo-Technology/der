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

// ---------------------------------------------------------------------------
// WASI part execution, mirroring platform/host/src/fragments.rs: a per-call
// (or per-job) sandbox whose /in holds exactly the granted files and whose
// /out is harvested into fresh grants; job starts park the live guest so
// steps run against its state.
// ---------------------------------------------------------------------------

import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { WasiGuest } from './wasm-host';
import { grantedPath, registerProducedFile } from './file-stubs';

interface WasiSandbox {
  root: string;
}

function createSandbox(): WasiSandbox {
  const root = mkdtempSync(join(tmpdir(), 'der-eval-wasi-'));
  mkdirSyncSafe(join(root, 'in'));
  mkdirSyncSafe(join(root, 'out'));
  return { root };
}

function mkdirSyncSafe(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

type WasiRoute = NonNullable<ReturnType<typeof PART_ROUTES.get>>;

function stageFileInputs(
  route: WasiRoute,
  sandbox: WasiSandbox,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const staged: Record<string, unknown> = { ...inputs };
  for (const spec of route.inputs) {
    if (spec.type !== 'file') continue;
    const token = staged[spec.name];
    if (typeof token !== 'string' || !token) continue;
    const real = grantedPath(token);
    if (!real) {
      throw new Error(`"${spec.name}" needs a picked file; run file.pick first`);
    }
    const name = basename(real);
    copyFileSync(real, join(sandbox.root, 'in', name));
    staged[spec.name] = `/in/${name}`;
  }
  return staged;
}

function harvestFileOutputs(
  route: WasiRoute,
  sandbox: WasiSandbox,
  result: Record<string, unknown>
): Record<string, unknown> {
  const declared = route.outputs.map((o) => o.name);
  for (const spec of route.outputs) {
    if (spec.type !== 'file') continue;
    const guestPath = result[spec.name];
    if (typeof guestPath !== 'string' || !guestPath.startsWith('/out/')) continue;
    const real = join(sandbox.root, 'out', guestPath.slice('/out/'.length));
    if (!existsSync(real)) {
      throw new Error(
        `Output "${spec.name}" names ${guestPath}, which the part did not write under /out`
      );
    }
    const registered = registerProducedFile(real);
    result[spec.name] = registered.file;
    for (const sibling of ['url', 'name', 'size']) {
      if (declared.includes(sibling) && !(sibling in result)) {
        result[sibling] = registered[sibling];
      }
    }
  }
  return result;
}

interface WasiJob {
  guest: WasiGuest;
  sandbox: WasiSandbox;
}

const wasiJobs = new Map<string, WasiJob>();
let jobSeq = 1;

function runWasiOperation(
  name: string,
  route: WasiRoute,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  if (!route.module) {
    throw new Error(`Part operation ${name} has no compute module`);
  }
  if (route.job === 'step') {
    const tokenInput = route.inputs.find((spec) => spec.type === 'job');
    const token = String((tokenInput && inputs[tokenInput.name]) ?? '');
    const job = wasiJobs.get(token);
    if (!job) {
      throw new Error(
        'No running job for this step; start it first (a finished or failed job is gone)'
      );
    }
    let result: Record<string, unknown>;
    try {
      result = job.guest.call(name, inputs);
    } catch (error) {
      wasiJobs.delete(token);
      throw error;
    }
    if (result.done === true) {
      wasiJobs.delete(token);
      return harvestFileOutputs(route, job.sandbox, result);
    }
    return result;
  }

  const sandbox = createSandbox();
  const staged = stageFileInputs(route, sandbox, inputs);
  const guest = new WasiGuest(route.module, {
    '/in': join(sandbox.root, 'in'),
    '/out': join(sandbox.root, 'out'),
  });
  const result = guest.call(name, staged);
  if (route.job === 'start') {
    const token = `derjob-eval-${jobSeq++}`;
    wasiJobs.set(token, { guest, sandbox });
    result.job = token;
    return result;
  }
  return harvestFileOutputs(route, sandbox, result);
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
          if (route.wasi) {
            return { ok: runWasiOperation(name, route, assembled) };
          }
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
  // Job instances and their sandboxes are scenario state.
  wasiJobs.clear();
  jobSeq = 1;
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
