/**
 * Runs the committed runtime conformance vectors against the TypeScript
 * kernel. The same vectors run against the Rust kernel in
 * src-tauri/tests/runtime_conformance.rs; together they hold the two
 * implementations to identical semantics. A failure here means the kernel's
 * behavior drifted from the frozen contract; change the vectors first
 * (scripts/runtime-conformance/generate.ts) if the change is intentional.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TRANSFORMS,
  applyBindingTransforms,
  applyTransformPipeline,
} from '../transforms';
import { parseRowExpression } from '../row-expression';
import { BUILTIN_OPERATIONS, FRAGMENT_ELEMENTS, assembleStructured } from '../registry';
import type { UiFragmentDef } from '../registry';
import { ExperienceStateManager } from '../../../components/runtime/ExperienceStateManager';
import { OperationExecutor } from '../../../components/runtime/OperationExecutor';
import { resolveViewTree } from '../../runtime-view/resolve-view';
import {
  extractStreamingContract,
  parsePartialJson,
} from '../../ai-interpreter/partial-json';
import { checkAgainstManifests } from '../../../schemas/contract';
import type { ContractShape } from '../../../schemas/contract';
import { expandPackOperations, expandUiFragment } from '../../fragments/ui-fragments';
import type { Contract, OperationBinding, UIElement } from '../../../types/contract';

const fixtureDir = resolve(__dirname, '../../../../runtime-conformance');

const transformFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'transforms.json'), 'utf8')
) as {
  transforms: Array<{
    name: string;
    transform: string;
    parameters: Record<string, unknown>;
    input: unknown;
    expected: unknown;
  }>;
  pipelines: Array<{
    name: string;
    steps: Array<{ type: string; parameters?: Record<string, unknown> }>;
    input: unknown;
    legacySingle: boolean;
    expected: unknown;
  }>;
};

const expressionFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'expressions.json'), 'utf8')
) as {
  expressions: Array<{
    name: string;
    expression: string;
    row?: Record<string, unknown>;
    identifiers?: string[];
    parseError: boolean;
    evalError?: boolean;
    value?: number;
  }>;
};

/** The vectors use JSON-value semantics: undefined normalizes to null. */
function jsonNormalize(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value ?? null));
}

describe('runtime conformance: transforms', () => {
  for (const vector of transformFixtures.transforms) {
    it(vector.name, () => {
      const def = TRANSFORMS[vector.transform];
      expect(def).toBeDefined();
      const actual = def.apply(vector.input, vector.parameters);
      expect(jsonNormalize(actual)).toEqual(vector.expected);
    });
  }
});

describe('runtime conformance: pipelines', () => {
  for (const vector of transformFixtures.pipelines) {
    it(vector.name, () => {
      const actual = vector.legacySingle
        ? applyBindingTransforms(vector.input, { transform: vector.steps[0] as never })
        : applyTransformPipeline(vector.input, vector.steps as never);
      expect(jsonNormalize(actual)).toEqual(vector.expected);
    });
  }
});

const operationFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'operations.json'), 'utf8')
) as {
  operations: Array<{
    name: string;
    operation: string;
    inputs: Record<string, unknown>;
    state: Record<string, unknown>;
    env: { ids: string[]; randoms: number[]; epochMs: number };
    shapeOnlyOutputs: string[];
    error: boolean;
    expected: { state: Record<string, unknown>; outputs: Record<string, unknown> };
  }>;
};

const OUTPUT_SHAPES: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}$/,
};

describe('runtime conformance: operations', () => {
  for (const vector of operationFixtures.operations) {
    it(vector.name, () => {
      const def = BUILTIN_OPERATIONS[vector.operation];
      expect(def).toBeDefined();

      const state: Record<string, unknown> = JSON.parse(JSON.stringify(vector.state));
      const ctx = {
        getState: (key: string) => state[key],
        setState: (key: string, value: unknown) => {
          state[key] = value;
        },
      };

      const idQueue = [...vector.env.ids];
      const randomQueue = [...vector.env.randoms];
      const cryptoObject = globalThis.crypto as { randomUUID?: () => string };
      const originalUuid = cryptoObject.randomUUID?.bind(cryptoObject);
      const originalRandom = Math.random;
      const OriginalDate = globalThis.Date;
      cryptoObject.randomUUID = () => idQueue.shift() ?? 'unscripted-id';
      Math.random = () => randomQueue.shift() ?? 0;
      class FixedDate extends OriginalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(vector.env.epochMs);
          } else {
            super(...(args as [number]));
          }
        }
        static now() {
          return vector.env.epochMs;
        }
      }
      (globalThis as { Date: unknown }).Date = FixedDate;

      try {
        const assembled = assembleStructured(vector.inputs, def.structuredPrefixes);
        let outputs: Record<string, unknown> | undefined;
        let failed = false;
        try {
          outputs = def.execute(assembled as never, ctx) as Record<string, unknown>;
        } catch {
          failed = true;
        }
        expect(failed).toBe(vector.error);
        expect(jsonNormalize(state)).toEqual(vector.expected.state);
        if (!vector.error && outputs) {
          for (const [name, value] of Object.entries(outputs)) {
            if (vector.shapeOnlyOutputs.includes(name)) {
              expect(String(value)).toMatch(OUTPUT_SHAPES[name]);
            } else {
              expect(jsonNormalize(value)).toEqual(vector.expected.outputs[name]);
            }
          }
          expect(Object.keys(outputs).sort()).toEqual(
            [...Object.keys(vector.expected.outputs), ...vector.shapeOnlyOutputs].sort()
          );
        }
      } finally {
        if (originalUuid) cryptoObject.randomUUID = originalUuid;
        Math.random = originalRandom;
        (globalThis as { Date: unknown }).Date = OriginalDate;
      }
    });
  }
});

const sessionFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'sessions.json'), 'utf8')
) as {
  sessions: Array<{
    name: string;
    operations: Array<Record<string, unknown>>;
    initialState: Record<string, unknown>;
    elements: Array<Record<string, unknown>>;
    env: { ids: string[]; randoms: number[]; epochMs: number };
    events: Array<
      | { do: 'setElement'; elementId: string; value: unknown }
      | { do: 'chain'; operationIds: string[]; item?: Record<string, unknown> }
    >;
    expected: { data: Record<string, unknown>; failed: string[] };
  }>;
};

describe('runtime conformance: sessions', () => {
  for (const vector of sessionFixtures.sessions) {
    it(vector.name, async () => {
      const idQueue = [...vector.env.ids];
      const randomQueue = [...vector.env.randoms];
      const cryptoObject = globalThis.crypto as { randomUUID?: () => string };
      const originalUuid = cryptoObject.randomUUID?.bind(cryptoObject);
      const originalRandom = Math.random;
      cryptoObject.randomUUID = () => idQueue.shift() ?? 'unscripted-id';
      Math.random = () => randomQueue.shift() ?? 0;

      try {
        const manager = new ExperienceStateManager('conformance');
        await manager.initializeState({
          initialState: vector.initialState,
          operations: vector.operations as unknown as OperationBinding[],
          elements: vector.elements,
        } as unknown as Contract);
        const executor = new OperationExecutor();
        const failed: string[] = [];

        for (const event of vector.events) {
          if (event.do === 'setElement') {
            manager.setData(`element_${event.elementId}`, event.value);
            continue;
          }
          for (const operationId of event.operationIds) {
            const operation = vector.operations.find((op) => op.id === operationId)!;
            try {
              const result = await executor.executeOperation(
                operation as unknown as OperationBinding,
                { item: event.item },
                manager
              );
              manager.updateStateFromOperationResult(
                operationId,
                result,
                (operation.outputs ?? []) as never
              );
            } catch {
              failed.push(operationId);
              break;
            }
          }
        }

        expect(jsonNormalize(manager.getState().data)).toEqual(vector.expected.data);
        expect(failed).toEqual(vector.expected.failed);
      } finally {
        if (originalUuid) cryptoObject.randomUUID = originalUuid;
        Math.random = originalRandom;
      }
    });
  }
});

const templateFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'templates.json'), 'utf8')
) as {
  templates: Array<{
    name: string;
    kind: 'fragment' | 'packOperations';
    def: UiFragmentDef;
    instance: Record<string, unknown>;
    expected: unknown;
  }>;
};

const viewFixtures = JSON.parse(readFileSync(resolve(fixtureDir, 'views.json'), 'utf8')) as {
  views: Array<{
    name: string;
    elements: Array<Record<string, unknown>>;
    state: Record<string, unknown>;
    fragmentDefs: Record<string, UiFragmentDef>;
    expected: unknown;
  }>;
};

/** Object keys holding null and absent keys are equivalent in the view
 * protocol; arrays keep nulls as real entries. */
function stripNullKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || entry === undefined) continue;
      out[key] = stripNullKeys(entry);
    }
    return out;
  }
  return value;
}

describe('runtime conformance: templates', () => {
  for (const vector of templateFixtures.templates) {
    it(vector.name, () => {
      if (vector.kind === 'fragment') {
        const expanded = expandUiFragment(vector.instance as unknown as UIElement, vector.def);
        expect(jsonNormalize(expanded)).toEqual(vector.expected);
        return;
      }
      FRAGMENT_ELEMENTS[vector.def.name] = vector.def;
      try {
        const packs = expandPackOperations([vector.instance as unknown as UIElement]);
        expect(jsonNormalize(packs.map((pack) => pack.operation))).toEqual(vector.expected);
      } finally {
        delete FRAGMENT_ELEMENTS[vector.def.name];
      }
    });
  }
});

describe('runtime conformance: views', () => {
  for (const vector of viewFixtures.views) {
    it(vector.name, () => {
      for (const [name, def] of Object.entries(vector.fragmentDefs)) {
        FRAGMENT_ELEMENTS[name] = def;
      }
      try {
        const tree = resolveViewTree(vector.elements as unknown as UIElement[], {
          data: vector.state,
        });
        expect(stripNullKeys(jsonNormalize(tree))).toEqual(vector.expected);
      } finally {
        for (const name of Object.keys(vector.fragmentDefs)) {
          delete FRAGMENT_ELEMENTS[name];
        }
      }
    });
  }
});

const streamingFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'streaming.json'), 'utf8')
) as {
  streaming: Array<{
    name: string;
    raw: string;
    partial: unknown;
    partialRecovered: boolean;
    contract: unknown;
  }>;
};

const validationFixtures = JSON.parse(
  readFileSync(resolve(fixtureDir, 'validation.json'), 'utf8')
) as {
  validation: Array<{
    name: string;
    contract: Record<string, unknown>;
    expected: { errors: unknown; warnings: unknown; mutated: unknown };
  }>;
};

describe('runtime conformance: validation', () => {
  for (const vector of validationFixtures.validation) {
    it(vector.name, () => {
      const contract = JSON.parse(JSON.stringify(vector.contract)) as ContractShape;
      const result = checkAgainstManifests(contract);
      expect(jsonNormalize(result.errors)).toEqual(vector.expected.errors);
      expect(jsonNormalize(result.warnings)).toEqual(vector.expected.warnings);
      expect(jsonNormalize(contract)).toEqual(vector.expected.mutated);
    });
  }
});

describe('runtime conformance: streaming', () => {
  for (const vector of streamingFixtures.streaming) {
    it(vector.name, () => {
      const partial = parsePartialJson(vector.raw);
      expect(partial !== null).toBe(vector.partialRecovered);
      if (vector.partialRecovered) {
        expect(jsonNormalize(partial)).toEqual(vector.partial);
      }
      const contract = extractStreamingContract(vector.raw);
      if (vector.contract === null) {
        expect(contract).toBeNull();
      } else {
        expect(jsonNormalize(contract)).toEqual(vector.contract);
      }
    });
  }
});

describe('runtime conformance: expressions', () => {
  for (const vector of expressionFixtures.expressions) {
    it(vector.name, () => {
      if (vector.parseError) {
        expect(() => parseRowExpression(vector.expression)).toThrow();
        return;
      }
      const parsed = parseRowExpression(vector.expression);
      expect([...parsed.identifiers].sort()).toEqual(vector.identifiers);
      if (vector.row === undefined) return;
      if (vector.evalError) {
        expect(() => parsed.evaluate(vector.row!)).toThrow();
        return;
      }
      expect(parsed.evaluate(vector.row)).toBe(vector.value);
    });
  }
});
