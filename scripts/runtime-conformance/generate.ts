/**
 * Generates the runtime conformance vectors in runtime-conformance/ from the
 * shipped TypeScript kernel (transforms and row expressions). The vectors are
 * the semantic contract between the webview runtime and the Rust runtime:
 * both test suites run every vector, so the two implementations cannot drift
 * apart silently. Expected values are JSON-value semantics (undefined
 * normalizes to null), because JSON is what crosses the renderer boundary.
 *
 *   npx tsx scripts/runtime-conformance/generate.ts
 *
 * Rerun only when kernel semantics intentionally change, and review the diff:
 * the committed vectors are the frozen truth, and an unreviewed regeneration
 * would enshrine a regression as the new contract.
 *
 * formatNumber and formatDate are deliberately absent: their output is locale
 * presentation owned by whichever renderer displays the value.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
import {
  TRANSFORMS,
  applyBindingTransforms,
  applyTransformPipeline,
} from '../../src/services/operations/transforms';
import { parseRowExpression } from '../../src/services/operations/row-expression';

interface TransformCase {
  name: string;
  transform: string;
  parameters: Record<string, unknown>;
  input: unknown;
}

interface PipelineCase {
  name: string;
  steps: Array<{ type: string; parameters?: Record<string, unknown> }>;
  input: unknown;
  /** Uses the legacy singular-transform skip-on-null path (one step only). */
  legacySingle?: boolean;
}

interface ExpressionCase {
  name: string;
  expression: string;
  row?: Record<string, unknown>;
}

const ROWS = [
  { id: 'a', name: 'Bolt', qty: 4, price: 2.5, category: 'hardware', done: true },
  { id: 'b', name: 'Washer', qty: 10, price: 0.5, category: 'hardware', done: false },
  { id: 'c', name: 'Tape', qty: '3', price: '1.25', category: 'consumable' },
];

const TRANSFORM_CASES: TransformCase[] = [
  { name: 'count array', transform: 'count', parameters: {}, input: [1, 2, 3] },
  { name: 'count empty', transform: 'count', parameters: {}, input: [] },
  { name: 'count null', transform: 'count', parameters: {}, input: null },
  { name: 'count scalar', transform: 'count', parameters: {}, input: 'nope' },

  { name: 'sum field', transform: 'sum', parameters: { field: 'qty' }, input: ROWS },
  { name: 'sum string numbers', transform: 'sum', parameters: { field: 'price' }, input: ROWS },
  { name: 'sum missing field', transform: 'sum', parameters: { field: 'ghost' }, input: ROWS },
  { name: 'sum whole entries', transform: 'sum', parameters: { field: '' }, input: [1, 2, '3', null] },
  { name: 'sum booleans coerce', transform: 'sum', parameters: { field: 'done' }, input: ROWS },
  { name: 'sum non-array', transform: 'sum', parameters: { field: 'qty' }, input: 7 },

  { name: 'filterBy match', transform: 'filterBy', parameters: { field: 'category', value: 'hardware' }, input: ROWS },
  { name: 'filterBy loose number', transform: 'filterBy', parameters: { field: 'qty', value: '4' }, input: ROWS },
  { name: 'filterBy empty keeps all', transform: 'filterBy', parameters: { field: 'category', value: '' }, input: ROWS },
  { name: 'filterBy null keeps all', transform: 'filterBy', parameters: { field: 'category', value: null }, input: ROWS },

  { name: 'filterContains hit', transform: 'filterContains', parameters: { field: 'name', value: 'oL' }, input: ROWS },
  { name: 'filterContains empty keeps all', transform: 'filterContains', parameters: { field: 'name', value: '' }, input: ROWS },
  { name: 'filterContains missing field', transform: 'filterContains', parameters: { field: 'ghost', value: 'x' }, input: ROWS },

  { name: 'filterTruthy', transform: 'filterTruthy', parameters: { field: 'done' }, input: ROWS },
  { name: 'filterFalsy counts missing', transform: 'filterFalsy', parameters: { field: 'done' }, input: ROWS },

  { name: 'sortBy numeric', transform: 'sortBy', parameters: { field: 'price' }, input: ROWS },
  { name: 'sortBy desc', transform: 'sortBy', parameters: { field: 'qty', direction: 'desc' }, input: ROWS },
  { name: 'sortBy strings', transform: 'sortBy', parameters: { field: 'name' }, input: ROWS },
  {
    name: 'sortBy stable on ties',
    transform: 'sortBy',
    parameters: { field: 'category' },
    input: [
      { id: 1, category: 'b' },
      { id: 2, category: 'a' },
      { id: 3, category: 'a' },
    ],
  },
  {
    name: 'sortBy mixed falls back to strings',
    transform: 'sortBy',
    parameters: { field: 'v' },
    input: [{ v: 'x' }, { v: 2 }, { v: 10 }],
  },

  { name: 'pick field', transform: 'pick', parameters: { field: 'name' }, input: ROWS[0] },
  { name: 'pick from array head', transform: 'pick', parameters: { field: 'name' }, input: ROWS },
  { name: 'pick dot path', transform: 'pick', parameters: { field: 'a.b' }, input: { a: { b: 5 } } },
  { name: 'pick missing', transform: 'pick', parameters: { field: 'ghost' }, input: ROWS[0] },
  { name: 'pick whole value', transform: 'pick', parameters: { field: '' }, input: 42 },

  { name: 'pluck', transform: 'pluck', parameters: { field: 'qty' }, input: ROWS },
  { name: 'pluck missing', transform: 'pluck', parameters: { field: 'ghost' }, input: ROWS },

  { name: 'equals loose', transform: 'equals', parameters: { value: '4' }, input: 4 },
  { name: 'equals miss', transform: 'equals', parameters: { value: 'x' }, input: 4 },
  { name: 'not truthy', transform: 'not', parameters: {}, input: 1 },
  { name: 'not empty string', transform: 'not', parameters: {}, input: '' },

  { name: 'parseNumber plain', transform: 'parseNumber', parameters: {}, input: ' 12.5 ' },
  { name: 'parseNumber junk', transform: 'parseNumber', parameters: {}, input: 'abc' },
  { name: 'parseNumber empty string', transform: 'parseNumber', parameters: {}, input: '' },
  { name: 'parseNumber null', transform: 'parseNumber', parameters: {}, input: null },
  { name: 'parseNumber bool', transform: 'parseNumber', parameters: {}, input: true },

  { name: 'round to integer', transform: 'round', parameters: {}, input: 2.5 },
  { name: 'round negative half', transform: 'round', parameters: {}, input: -2.5 },
  { name: 'round two decimals is a string', transform: 'round', parameters: { decimals: 2 }, input: 1.005 },
  { name: 'round float artifact', transform: 'round', parameters: { decimals: 2 }, input: 0.1 + 0.2 },
  { name: 'round non-numeric passes through', transform: 'round', parameters: { decimals: 2 }, input: 'abc' },
  { name: 'round string number', transform: 'round', parameters: { decimals: 1 }, input: '2.55' },

  { name: 'format inserts value', transform: 'format', parameters: { template: 'Total: {{value}} items' }, input: 3 },
  { name: 'format first placeholder only', transform: 'format', parameters: { template: '{{value}} and {{value}}' }, input: 'x' },
  { name: 'format null becomes empty', transform: 'format', parameters: { template: '[{{value}}]' }, input: null },
  { name: 'format float repr', transform: 'format', parameters: { template: '{{value}}' }, input: 0.1 + 0.2 },
  { name: 'format integer valued float', transform: 'format', parameters: { template: '{{value}}' }, input: 3.0 },
  { name: 'format missing template passes through', transform: 'format', parameters: {}, input: 7 },

  { name: 'map hit', transform: 'map', parameters: { mapping: { true: 'done', false: '' } }, input: true },
  { name: 'map miss passes through', transform: 'map', parameters: { mapping: { a: 'b' } }, input: 'z' },
  { name: 'map non-object passes through', transform: 'map', parameters: { mapping: 'nope' }, input: 'z' },

  {
    name: 'deriveField products',
    transform: 'deriveField',
    parameters: { field: 'value', expression: 'qty * price' },
    input: ROWS,
  },
  {
    name: 'deriveField null on missing field',
    transform: 'deriveField',
    parameters: { field: 'value', expression: 'qty * ghost' },
    input: ROWS,
  },
  {
    name: 'deriveField bad expression degrades',
    transform: 'deriveField',
    parameters: { field: 'value', expression: 'qty *' },
    input: ROWS,
  },
  {
    name: 'deriveField skips non-objects',
    transform: 'deriveField',
    parameters: { field: 'v', expression: '1 + 1' },
    input: [{ a: 1 }, 5, null],
  },
];

const PIPELINE_CASES: PipelineCase[] = [
  {
    name: 'derive then sum then round then format',
    steps: [
      { type: 'deriveField', parameters: { field: 'value', expression: 'qty * price' } },
      { type: 'sum', parameters: { field: 'value' } },
      { type: 'round', parameters: { decimals: 2 } },
      { type: 'format', parameters: { template: 'Total: $ {{value}}' } },
    ],
    input: ROWS,
  },
  {
    name: 'filter then count',
    steps: [
      { type: 'filterBy', parameters: { field: 'category', value: 'hardware' } },
      { type: 'count', parameters: {} },
    ],
    input: ROWS,
  },
  {
    name: 'pipeline runs on undefined input',
    steps: [{ type: 'count', parameters: {} }],
    input: undefined,
  },
  {
    name: 'unknown step passes value through',
    steps: [{ type: 'nonexistent', parameters: {} }, { type: 'count', parameters: {} }],
    input: [1, 2],
  },
  {
    name: 'legacy single transform skips null input',
    steps: [{ type: 'count', parameters: {} }],
    input: null,
    legacySingle: true,
  },
  {
    name: 'legacy single transform applies to values',
    steps: [{ type: 'parseNumber', parameters: {} }],
    input: '41',
    legacySingle: true,
  },
];

const EXPRESSION_CASES: ExpressionCase[] = [
  { name: 'product', expression: 'qty * price', row: { qty: 4, price: 2.5 } },
  { name: 'precedence', expression: '1 + 2 * 3', row: {} },
  { name: 'parentheses', expression: '(1 + 2) * 3', row: {} },
  { name: 'power right associative', expression: '2 ^ 3 ^ 2', row: {} },
  { name: 'unary binds before power', expression: '-2 ^ 2', row: {} },
  { name: 'negative exponent', expression: '2 ^ -1', row: {} },
  { name: 'modulo', expression: '9 % 4', row: {} },
  { name: 'float artifacts', expression: '0.1 + 0.2', row: {} },
  { name: 'case insensitive fields', expression: 'qty * price', row: { Qty: '4', PRICE: '1.5' } },
  { name: 'whitespace number field', expression: 'qty + 1', row: { qty: ' 4 ' } },
  { name: 'functions', expression: 'round(sqrt(x) + min(a, b) + max(a, b) + pow(2, 3))', row: { x: 9, a: 1, b: 2 } },
  { name: 'abs floor ceil', expression: 'abs(-2) + floor(2.7) + ceil(2.1)', row: {} },
  { name: 'constants', expression: 'floor(pi) + floor(e)', row: {} },
  { name: 'division', expression: 'a / b', row: { a: 1, b: 8 } },

  { name: 'missing field errors', expression: 'qty * ghost', row: { qty: 2 } },
  { name: 'non numeric field errors', expression: 'qty + 1', row: { qty: 'many' } },
  { name: 'division by zero errors', expression: '1 / n', row: { n: 0 } },
  { name: 'modulo by zero errors', expression: '1 % n', row: { n: 0 } },
  { name: 'negative sqrt errors', expression: 'sqrt(n)', row: { n: -1 } },

  { name: 'dangling operator', expression: 'qty *' },
  { name: 'unclosed parenthesis', expression: '(qty' },
  { name: 'unknown function', expression: 'hack(1)' },
  { name: 'min arity', expression: 'min(1)' },
  { name: 'sqrt arity', expression: 'sqrt(1, 2)' },
  { name: 'empty expression', expression: '' },
  { name: 'statement injection', expression: 'qty; alert(1)', row: { qty: 1 } },
  { name: 'too deep', expression: `${'('.repeat(70)}1${')'.repeat(70)}` },
];

/** JSON-value semantics: undefined normalizes to null, matching what any
 * renderer boundary serialization would produce. */
function jsonNormalize(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value ?? null));
}

function main(): void {
  const outDir = resolve(scriptDir, '../../runtime-conformance');
  mkdirSync(outDir, { recursive: true });

  const transforms = TRANSFORM_CASES.map((entry) => {
    const def = TRANSFORMS[entry.transform];
    if (!def) throw new Error(`No transform ${entry.transform}`);
    const expected = def.apply(entry.input, entry.parameters);
    return {
      name: entry.name,
      transform: entry.transform,
      parameters: entry.parameters,
      input: jsonNormalize(entry.input),
      expected: jsonNormalize(expected),
    };
  });

  const pipelines = PIPELINE_CASES.map((entry) => {
    const expected = entry.legacySingle
      ? applyBindingTransforms(entry.input, { transform: entry.steps[0] as never })
      : applyTransformPipeline(entry.input, entry.steps as never);
    return {
      name: entry.name,
      steps: entry.steps,
      input: jsonNormalize(entry.input),
      legacySingle: entry.legacySingle ?? false,
      expected: jsonNormalize(expected),
    };
  });

  const expressions = EXPRESSION_CASES.map((entry) => {
    let parsed;
    try {
      parsed = parseRowExpression(entry.expression);
    } catch {
      return { name: entry.name, expression: entry.expression, parseError: true };
    }
    const identifiers = [...parsed.identifiers].sort();
    if (entry.row === undefined) {
      return { name: entry.name, expression: entry.expression, identifiers, parseError: false };
    }
    try {
      const value = parsed.evaluate(entry.row);
      return {
        name: entry.name,
        expression: entry.expression,
        row: entry.row,
        identifiers,
        parseError: false,
        value,
      };
    } catch {
      return {
        name: entry.name,
        expression: entry.expression,
        row: entry.row,
        identifiers,
        parseError: false,
        evalError: true,
      };
    }
  });

  writeFileSync(
    resolve(outDir, 'transforms.json'),
    JSON.stringify({ formatVersion: 1, transforms, pipelines }, null, 2) + '\n'
  );
  writeFileSync(
    resolve(outDir, 'expressions.json'),
    JSON.stringify({ formatVersion: 1, expressions }, null, 2) + '\n'
  );
  process.stdout.write(
    `wrote ${transforms.length} transform, ${pipelines.length} pipeline, ${expressions.length} expression vectors\n`
  );
}

main();
