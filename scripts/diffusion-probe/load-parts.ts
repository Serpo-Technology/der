/**
 * Registers the repo's signed bundles into the in-process registries so
 * probe prompts and validation match an app with the parts installed.
 * Operation execute functions are stubs; this is offline tooling.
 */

import { readFileSync, readdirSync } from 'node:fs';
import {
  FRAGMENT_ELEMENTS,
  FRAGMENT_OPERATIONS,
  FRAGMENT_RECIPES,
} from '../../src/services/operations/registry';

export function loadDistParts(dir: string): void {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.derpart')) continue;
    const envelope = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    const manifest = JSON.parse(
      Buffer.from(envelope.manifestB64, 'base64').toString('utf8')
    );
    for (const op of manifest.operations ?? []) {
      FRAGMENT_OPERATIONS[op.name] = {
        name: op.name,
        description: op.description,
        inputs: op.inputs ?? [],
        outputs: op.outputs ?? [],
        howto: op.howto,
        example: op.example,
        structuredPrefixes: op.structuredPrefixes,
        execute: async () => ({}),
      };
    }
    for (const fragment of manifest.uiFragments ?? []) {
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
