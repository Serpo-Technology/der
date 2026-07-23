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
} from '../../src/services/operations/registry';
import { runGuest } from './wasm-host';

let remoteStubs: Record<string, Record<string, unknown>> = {};

export function setRemoteStubs(stubs: Record<string, Record<string, unknown>>): void {
  remoteStubs = stubs;
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
    for (const op of manifest.operations ?? []) {
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
      FRAGMENT_ELEMENTS[fragment.name] = {
        name: fragment.name,
        description: fragment.description,
        howto: fragment.howto,
        params: fragment.params ?? [],
        template: fragment.template,
      };
    }
  }
}
