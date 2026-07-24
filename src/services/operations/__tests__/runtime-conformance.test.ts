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
import { BUILTIN_OPERATIONS, assembleStructured } from '../registry';

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
