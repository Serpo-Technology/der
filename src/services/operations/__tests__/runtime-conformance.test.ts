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
