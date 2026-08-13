/**
 * Registers the repo's signed bundles for behavioral runs with runnable
 * executes: compute operations run their real wasm guest in-process, remote
 * operations return the active scenario's stubbed responses (behavioral
 * evals must not depend on live services).
 */

import { readFileSync, readdirSync } from 'node:fs';
import {
  FRAGMENT_ELEMENTS,
  FRAGMENT_OPERATIONS,
  FRAGMENT_RECIPES,
} from '../../src/services/operations/registry';
import { runGuest } from './wasm-host';

let remoteStubs: Record<string, Record<string, unknown>> = {};

export function setRemoteStubs(stubs: Record<string, Record<string, unknown>>): void {
  remoteStubs = stubs;
}

export function remoteStub(name: string): Record<string, unknown> | undefined {
  return remoteStubs[name];
}

/** Sync execution surface for the kernel host: precompiled modules for
 * compute operations, a remote flag for stub routing. */
export interface PartIoSpec {
  name: string;
  type?: string;
}

export const PART_ROUTES = new Map<
  string,
  {
    remote: boolean;
    module?: WebAssembly.Module;
    structuredPrefixes?: string[];
    /** wasi capability declarations from the manifest; wasi parts run
     * under node:wasi with a sandbox mirroring the host's. */
    wasi: boolean;
    /** "start" | "step" for job-scoped operations. */
    job?: string;
    inputs: PartIoSpec[];
    outputs: PartIoSpec[];
  }
>();

/** Raw uiFragments defs by name, the shape the kernel's resolver expands. */
export const FRAGMENT_DEFS: Record<string, unknown> = {};

/** Raw manifest operation defs and recipes, the kernel vocabulary shape. */
export const RAW_PART_OPS: Record<string, unknown> = {};
export const RAW_RECIPES: Record<string, unknown> = {};

export function kernelVocabulary(): Record<string, unknown> {
  return {
    fragmentDefs: FRAGMENT_DEFS,
    partOperations: RAW_PART_OPS,
    credentials: [],
    recipes: RAW_RECIPES,
  };
}

export function registerRunnableParts(dir: string): void {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.derpart')) continue;
    const envelope = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    const manifest = JSON.parse(
      Buffer.from(envelope.manifestB64, 'base64').toString('utf8')
    );
    const wasmBytes = envelope.wasmB64
      ? new Uint8Array(Buffer.from(envelope.wasmB64, 'base64'))
      : null;
    const compiled = wasmBytes ? new WebAssembly.Module(wasmBytes as BufferSource) : undefined;
    for (const recipe of manifest.recipes ?? []) {
      RAW_RECIPES[recipe.name] = recipe;
    }
    for (const op of manifest.operations ?? []) {
      RAW_PART_OPS[op.name] = op;
      PART_ROUTES.set(op.name, {
        remote: Boolean(op.remote),
        module: op.remote ? undefined : compiled,
        structuredPrefixes: op.structuredPrefixes,
        wasi: (manifest.capabilities ?? []).some((c: string) => c.startsWith('wasi:')),
        job: op.job,
        inputs: op.inputs ?? [],
        outputs: op.outputs ?? [],
      });
      FRAGMENT_OPERATIONS[op.name] = {
        name: op.name,
        description: op.description,
        inputs: op.inputs ?? [],
        outputs: op.outputs ?? [],
        howto: op.howto,
        example: op.example,
        structuredPrefixes: op.structuredPrefixes,
        execute: op.remote
          ? async () => {
              const stub = remoteStubs[op.name];
              if (!stub) {
                throw new Error(`Scenario has no stub for remote operation ${op.name}`);
              }
              return stub;
            }
          : async (inputs) => {
              if (!wasmBytes) {
                throw new Error(`Part ${manifest.id} has no compute module for ${op.name}`);
              }
              return await runGuest(wasmBytes, op.name, inputs);
            },
      };
    }
    for (const fragment of manifest.uiFragments ?? []) {
      FRAGMENT_DEFS[fragment.name] = fragment;
      FRAGMENT_ELEMENTS[fragment.name] = {
        name: fragment.name,
        description: fragment.description,
        howto: fragment.howto,
        params: fragment.params ?? [],
        template: fragment.template,
        operations: fragment.operations,
      };
    }
    for (const recipe of manifest.recipes ?? []) {
      FRAGMENT_RECIPES[recipe.name] = {
        name: recipe.name,
        title: recipe.title,
        description: recipe.description,
        keywords: recipe.keywords ?? [],
        spec: recipe.spec,
        contract: recipe.contract,
        partId: manifest.id,
        publisher: manifest.publisher,
      };
    }
  }
}
