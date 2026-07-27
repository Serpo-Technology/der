/**
 * The webview face's own kernel host. When no desktop core is behind the
 * window (a plain browser, `npm run dev`), the committed kernel wasm loads
 * in-process and serves the same session protocol and contract commands the
 * desktop core answers over invoke, so the face works identically to the
 * native panel: presentation over the protocol, one kernel underneath.
 * Host-owned capabilities (network, files, mail, the record store,
 * installed parts) have no host here; dispatching one fails its chain with
 * a message naming the desktop app, shown on the error strip like any
 * operation failure.
 */

import kernelWasmUrl from '../../../runtime-wasm/dist/der_runtime_kernel.wasm?url';
import { instantiateKernel, KernelInstance, KernelRequest } from './wasm-kernel';
import {
  setSessionTransport,
  SessionTransport,
  SessionOpened,
  EventOutcome,
} from './session-client';
import { setCoreCommandRouter } from './core-invoke';
import {
  FRAGMENT_ELEMENTS,
  FRAGMENT_OPERATIONS,
  INTEGRATION_CREDENTIALS,
} from '../operations/registry';
import type { ResolvedNode } from '../runtime-view/resolve-view';

function randomId(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomFloat(): number {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.getRandomValues) {
    const buffer = new Uint32Array(1);
    globalCrypto.getRandomValues(buffer);
    return buffer[0] / 0x100000000;
  }
  return Math.random();
}

function hostCall(request: KernelRequest): { ok?: unknown; err?: string } {
  switch (request.operation) {
    case 'env.id':
      return { ok: randomId() };
    case 'env.random':
      return { ok: randomFloat() };
    case 'env.now':
      return { ok: Date.now() };
    case 'env.tzOffset':
      return { ok: -new Date().getTimezoneOffset() };
    case 'dispatch': {
      const payload = request.request as { operationName?: string } | undefined;
      const name = payload?.operationName ?? 'this operation';
      return { err: `"${name}" needs the DER desktop app` };
    }
    default:
      return { err: `Unknown host operation ${String(request.operation)}` };
  }
}

let kernelPromise: Promise<KernelInstance> | null = null;

function kernel(bytes?: ArrayBuffer | ArrayBufferView): Promise<KernelInstance> {
  if (!kernelPromise) {
    kernelPromise = (async () => {
      const binary = bytes ?? (await (await fetch(kernelWasmUrl)).arrayBuffer());
      return instantiateKernel(binary, { call: hostCall });
    })();
  }
  return kernelPromise;
}

/** Installed vocabulary as the session and checker expect it. In a plain
 * browser nothing is installed, so these are empty; the mapping keeps the
 * host correct wherever the registries do hold entries. */
function vocabulary(): Record<string, unknown> {
  return {
    fragmentDefs: FRAGMENT_ELEMENTS,
    partOperations: FRAGMENT_OPERATIONS,
    credentials: INTEGRATION_CREDENTIALS,
    recipes: {},
  };
}

function createTransport(): SessionTransport {
  let counter = 0;
  return {
    async open(contract, initialData, experienceId) {
      const instance = await kernel();
      const sessionId = `web-${experienceId}-${counter++}`;
      const reply = instance.run({
        operation: 'session.open',
        sessionId,
        contract,
        initialData,
        fragmentDefs: FRAGMENT_ELEMENTS,
      }) as { tree: ResolvedNode[]; state: Record<string, unknown> };
      return { sessionId, tree: reply.tree, state: reply.state } as SessionOpened;
    },
    async setElement(sessionId, elementId, value) {
      const instance = await kernel();
      const reply = instance.run({
        operation: 'session.setElement',
        sessionId,
        elementId,
        value,
      }) as { tree: ResolvedNode[] };
      return reply.tree;
    },
    async dispatch(sessionId, operationIds, item) {
      const instance = await kernel();
      return instance.run({
        operation: 'session.dispatch',
        sessionId,
        operationIds,
        item,
      }) as EventOutcome;
    },
    async close(sessionId) {
      const instance = await kernel();
      instance.run({ operation: 'session.close', sessionId });
    },
  };
}

async function routeCommand(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const instance = await kernel();
  switch (command) {
    case 'runtime_check_contract':
      return instance.run({
        operation: 'contract.check',
        contract: args.contract,
        ...vocabulary(),
      });
    case 'runtime_finalize_contract': {
      const reply = instance.run({
        operation: 'capture.finalize',
        shape: args.shape,
        ...(args.description !== undefined ? { description: args.description } : {}),
        nowIso: new Date().toISOString(),
        ...vocabulary(),
      }) as { contract: unknown };
      return reply.contract;
    }
    case 'runtime_extract_streaming': {
      const reply = instance.run({
        operation: 'streaming.extract',
        accumulated: args.accumulated,
      }) as { contract: unknown };
      return reply.contract ?? null;
    }
    case 'runtime_derive_blueprint': {
      const reply = instance.run({
        operation: 'blueprint.derive',
        contract: args.contract,
        description: args.description ?? '',
      }) as { blueprint: unknown };
      return reply.blueprint;
    }
    default:
      throw new Error(`"${command}" needs the DER desktop app`);
  }
}

/**
 * Makes this window a self-sufficient face: sessions and contract commands
 * are answered by the in-process kernel from here on. Synchronous; the
 * kernel itself loads lazily behind the first call. Tests may hand in the
 * kernel bytes directly to skip the fetch.
 */
export function installBrowserCore(options?: { bytes?: ArrayBuffer | ArrayBufferView }): void {
  if (options?.bytes) {
    void kernel(options.bytes);
  }
  setSessionTransport(createTransport());
  setCoreCommandRouter(routeCommand);
}

/** Removes the browser host again; test hygiene only. */
export function uninstallBrowserCore(): void {
  setSessionTransport(undefined);
  setCoreCommandRouter(null);
  kernelPromise = null;
}
