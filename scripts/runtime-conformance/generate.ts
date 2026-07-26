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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
import { TRANSFORMS } from '../../src/services/operations/transforms';
import { BUILTIN_OPERATIONS } from '../../src/services/operations/registry';
import { ContractSchema, LlmContractSchema } from '../../src/schemas/contract';
import type { ContractShape } from '../../src/schemas/contract';
import { instantiateKernel, KernelInstance } from '../../src/services/runtime-core/wasm-kernel';

// Expectations come from the reference implementation itself: the runtime
// kernel's wasm build answers every computation below, so the corpus is
// authored by the exact semantics both faces ship.
let kernel: KernelInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kcall(operation: string, payload: Record<string, unknown> = {}): any {
  return kernel.run({ operation, ...payload });
}
import {
  ELEMENT_MANIFESTS,
  FRAGMENT_OPERATIONS,
  FRAGMENT_RECIPES,
  INTRINSIC_ELEMENT_TYPES,
  setIntegrationCredentials,
} from '../../src/services/operations/registry';
import type { IntegrationCredentialView, RecipeDef } from '../../src/services/operations/registry';
import {
  BLUEPRINT_PROMPT_SECTION,
  CREATE_PROMPT_SECTION,
  EDIT_PROMPT_SECTION,
  buildBasePrompt,
  checkComposedCandidate,
  finalizeContractShape,
  renderCatalogText,
} from '../../src/services/ai-interpreter/contract-builder';
import {
  generateValidatedJson,
  parseValidatedJson,
} from '../../src/services/ai-interpreter/llm-json';
import type { LLMClient } from '../../src/services/ai-interpreter/llm-client';
import { expandUiFragment, expandPackOperations } from '../../src/services/fragments/ui-fragments';
import { FRAGMENT_ELEMENTS, UiFragmentDef } from '../../src/services/operations/registry';
import type { Contract, OperationBinding, UIElement } from '../../src/types/contract';

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
  {
    name: 'sum whole entries',
    transform: 'sum',
    parameters: { field: '' },
    input: [1, 2, '3', null],
  },
  { name: 'sum booleans coerce', transform: 'sum', parameters: { field: 'done' }, input: ROWS },
  { name: 'sum non-array', transform: 'sum', parameters: { field: 'qty' }, input: 7 },

  {
    name: 'filterBy match',
    transform: 'filterBy',
    parameters: { field: 'category', value: 'hardware' },
    input: ROWS,
  },
  {
    name: 'filterBy loose number',
    transform: 'filterBy',
    parameters: { field: 'qty', value: '4' },
    input: ROWS,
  },
  {
    name: 'filterBy empty keeps all',
    transform: 'filterBy',
    parameters: { field: 'category', value: '' },
    input: ROWS,
  },
  {
    name: 'filterBy null keeps all',
    transform: 'filterBy',
    parameters: { field: 'category', value: null },
    input: ROWS,
  },

  {
    name: 'filterContains hit',
    transform: 'filterContains',
    parameters: { field: 'name', value: 'oL' },
    input: ROWS,
  },
  {
    name: 'filterContains empty keeps all',
    transform: 'filterContains',
    parameters: { field: 'name', value: '' },
    input: ROWS,
  },
  {
    name: 'filterContains missing field',
    transform: 'filterContains',
    parameters: { field: 'ghost', value: 'x' },
    input: ROWS,
  },

  { name: 'filterTruthy', transform: 'filterTruthy', parameters: { field: 'done' }, input: ROWS },
  {
    name: 'filterFalsy counts missing',
    transform: 'filterFalsy',
    parameters: { field: 'done' },
    input: ROWS,
  },

  { name: 'sortBy numeric', transform: 'sortBy', parameters: { field: 'price' }, input: ROWS },
  {
    name: 'sortBy desc',
    transform: 'sortBy',
    parameters: { field: 'qty', direction: 'desc' },
    input: ROWS,
  },
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
  {
    name: 'pick dot path',
    transform: 'pick',
    parameters: { field: 'a.b' },
    input: { a: { b: 5 } },
  },
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
  {
    name: 'round two decimals is a string',
    transform: 'round',
    parameters: { decimals: 2 },
    input: 1.005,
  },
  {
    name: 'round float artifact',
    transform: 'round',
    parameters: { decimals: 2 },
    input: 0.1 + 0.2,
  },
  {
    name: 'round non-numeric passes through',
    transform: 'round',
    parameters: { decimals: 2 },
    input: 'abc',
  },
  { name: 'round string number', transform: 'round', parameters: { decimals: 1 }, input: '2.55' },

  {
    name: 'groupSum groups in first-seen order',
    transform: 'groupSum',
    parameters: { by: 'category', field: 'amount' },
    input: [
      { category: 'food', amount: 12 },
      { category: 'travel', amount: 30 },
      { category: 'food', amount: 8 },
      { category: 'other', amount: '5.5' },
    ],
  },
  {
    name: 'groupSum nulls group under the empty key and coerce to zero',
    transform: 'groupSum',
    parameters: { by: 'category', field: 'amount' },
    input: [
      { amount: 3 },
      { category: null, amount: 'seven' },
      { category: '', amount: 4 },
    ],
  },
  {
    name: 'format inserts value',
    transform: 'format',
    parameters: { template: 'Total: {{value}} items' },
    input: 3,
  },
  {
    name: 'format first placeholder only',
    transform: 'format',
    parameters: { template: '{{value}} and {{value}}' },
    input: 'x',
  },
  {
    name: 'format null becomes empty',
    transform: 'format',
    parameters: { template: '[{{value}}]' },
    input: null,
  },
  {
    name: 'format named slots fill from parameters',
    transform: 'format',
    parameters: { template: 'WIFI:T:WPA;S:{{value}};P:{{pw}};;', pw: 'hunter2' },
    input: 'homenet',
  },
  {
    name: 'format repeated and missing slots',
    transform: 'format',
    parameters: { template: '{{a}}-{{a}}-{{ghost}}-{{value}}', a: 'x' },
    input: 'v',
  },
  {
    name: 'format null slot empties and numbers coerce',
    transform: 'format',
    parameters: { template: '[{{gone}}] {{n}}', gone: null, n: 7 },
    input: '',
  },
  {
    name: 'format float repr',
    transform: 'format',
    parameters: { template: '{{value}}' },
    input: 0.1 + 0.2,
  },
  {
    name: 'format integer valued float',
    transform: 'format',
    parameters: { template: '{{value}}' },
    input: 3.0,
  },
  { name: 'format missing template passes through', transform: 'format', parameters: {}, input: 7 },

  {
    name: 'map hit',
    transform: 'map',
    parameters: { mapping: { true: 'done', false: '' } },
    input: true,
  },
  {
    name: 'map miss passes through',
    transform: 'map',
    parameters: { mapping: { a: 'b' } },
    input: 'z',
  },
  {
    name: 'map non-object passes through',
    transform: 'map',
    parameters: { mapping: 'nope' },
    input: 'z',
  },

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
    steps: [
      { type: 'nonexistent', parameters: {} },
      { type: 'count', parameters: {} },
    ],
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
  {
    name: 'functions',
    expression: 'round(sqrt(x) + min(a, b) + max(a, b) + pow(2, 3))',
    row: { x: 9, a: 1, b: 2 },
  },
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

interface OperationCase {
  name: string;
  operation: string;
  /** Executor-resolved flat inputs, dotted prefixes still flat. */
  inputs: Record<string, unknown>;
  state: Record<string, unknown>;
  env?: { ids?: string[]; randoms?: number[] };
  /** time.now vectors: local date and time are asserted by shape, never
   * byte-exact, so the corpus stays timezone-independent. */
  shapeOnlyOutputs?: string[];
}

const FIXED_EPOCH_MS = 1753315200000;

const TODO_STATE = {
  todos: [
    { id: 't1', title: 'wash car', completed: false },
    { id: 't2', title: 'write report', completed: true },
  ],
};

const OPERATION_CASES: OperationCase[] = [
  {
    name: 'state.set writes and echoes',
    operation: 'state.set',
    inputs: { key: 'view', value: 'done' },
    state: {},
  },
  {
    name: 'state.set typed value',
    operation: 'state.set',
    inputs: { key: 'running', value: true },
    state: { running: false },
  },
  {
    name: 'state.set missing value stores null',
    operation: 'state.set',
    inputs: { key: 'x' },
    state: {},
  },

  {
    name: 'counter.add default amount',
    operation: 'counter.add',
    inputs: { key: 'clicks' },
    state: { clicks: 2 },
  },
  {
    name: 'counter.add unseeded key',
    operation: 'counter.add',
    inputs: { key: 'clicks' },
    state: {},
  },
  {
    name: 'counter.add negative amount',
    operation: 'counter.add',
    inputs: { key: 'n', amount: -2 },
    state: { n: 5 },
  },
  {
    name: 'counter.add junk amount is zero',
    operation: 'counter.add',
    inputs: { key: 'n', amount: 'x' },
    state: { n: 5 },
  },
  {
    name: 'counter.add string state coerces',
    operation: 'counter.add',
    inputs: { key: 'n' },
    state: { n: '41' },
  },

  {
    name: 'list.append assembles fields and generates the id',
    operation: 'list.append',
    inputs: { key: 'expenses', 'item.description': 'lunch', 'item.amount': 12.5 },
    state: { expenses: [] },
    env: { ids: ['gen-1'] },
  },
  {
    name: 'list.append keeps null fields once one is meaningful',
    operation: 'list.append',
    inputs: { key: 'rows', 'item.title': 'x', 'item.note': null },
    state: {},
    env: { ids: ['gen-2'] },
  },
  {
    name: 'list.append skips when every field is blank',
    operation: 'list.append',
    inputs: { key: 'rows', 'item.title': '  ', 'item.note': null },
    state: { rows: [{ id: 'a', title: 'kept' }] },
  },
  {
    name: 'list.append overwrites a supplied id',
    operation: 'list.append',
    inputs: { key: 'rows', 'item.id': 'forged', 'item.title': 'x' },
    state: {},
    env: { ids: ['gen-3'] },
  },

  {
    name: 'list.updateWhere merges set fields on matches',
    operation: 'list.updateWhere',
    inputs: { key: 'cards', value: 'c1', 'set.column': 'doing', 'set.owner': 'Ana' },
    state: {
      cards: [
        { id: 'c1', column: 'todo' },
        { id: 'c2', column: 'todo' },
      ],
    },
  },
  {
    name: 'list.updateWhere matches loosely on a custom field',
    operation: 'list.updateWhere',
    inputs: { key: 'rows', field: 'qty', value: '4', 'set.flag': true },
    state: {
      rows: [
        { id: 'a', qty: 4 },
        { id: 'b', qty: 10 },
      ],
    },
  },
  {
    name: 'list.updateWhere counts zero on no match',
    operation: 'list.updateWhere',
    inputs: { key: 'rows', value: 'ghost', 'set.flag': true },
    state: { rows: [{ id: 'a' }] },
  },

  {
    name: 'list.removeWhere drops matches',
    operation: 'list.removeWhere',
    inputs: { key: 'rows', value: 'a' },
    state: { rows: [{ id: 'a' }, { id: 'b' }] },
  },
  {
    name: 'list.removeWhere loose id match',
    operation: 'list.removeWhere',
    inputs: { key: 'rows', value: 1 },
    state: { rows: [{ id: '1' }, { id: '2' }] },
  },

  {
    name: 'list.toggleField flips the default field',
    operation: 'list.toggleField',
    inputs: { key: 'todos', id: 't1' },
    state: TODO_STATE,
  },
  {
    name: 'list.toggleField sets true when the field is missing',
    operation: 'list.toggleField',
    inputs: { key: 'rows', id: 'a', field: 'starred' },
    state: { rows: [{ id: 'a' }] },
  },

  {
    name: 'math.add coerces junk to zero',
    operation: 'math.add',
    inputs: { a: '2.5', b: 'x' },
    state: {},
  },

  {
    name: 'time.now emits the injected instant',
    operation: 'time.now',
    inputs: {},
    state: {},
    shapeOnlyOutputs: ['date', 'time'],
  },

  {
    name: 'random.int rolls within the closed range',
    operation: 'random.int',
    inputs: { min: 1, max: 6 },
    state: {},
    env: { randoms: [0.999] },
  },
  {
    name: 'random.int swapped bounds',
    operation: 'random.int',
    inputs: { min: 6, max: 1 },
    state: {},
    env: { randoms: [0] },
  },
  {
    name: 'random.int numeric strings coerce',
    operation: 'random.int',
    inputs: { min: '2', max: '2' },
    state: {},
    env: { randoms: [0.5] },
  },
  {
    name: 'random.int junk bounds error',
    operation: 'random.int',
    inputs: { min: 'x', max: 6 },
    state: {},
  },

  {
    name: 'random.pick chooses by roll',
    operation: 'random.pick',
    inputs: { list: ['a', 'b', 'c'] },
    state: {},
    env: { randoms: [0.7] },
  },
  {
    name: 'random.pick empty list errors',
    operation: 'random.pick',
    inputs: { list: [] },
    state: {},
  },

  {
    name: 'todos.add trims and stamps',
    operation: 'todos.add',
    inputs: { title: '  buy milk  ' },
    state: TODO_STATE,
    env: { ids: ['t3'] },
  },
  {
    name: 'todos.add blank skips',
    operation: 'todos.add',
    inputs: { title: '   ' },
    state: TODO_STATE,
  },
  {
    name: 'todos.toggle flips by id',
    operation: 'todos.toggle',
    inputs: { id: 't2' },
    state: TODO_STATE,
  },
  {
    name: 'todos.remove drops by id',
    operation: 'todos.remove',
    inputs: { id: 't1' },
    state: TODO_STATE,
  },
];

type SessionEvent =
  | { do: 'setElement'; elementId: string; value: unknown }
  | { do: 'chain'; operationIds: string[]; item?: Record<string, unknown> };

interface SessionCase {
  name: string;
  operations: Array<Record<string, unknown>>;
  initialState?: Record<string, unknown>;
  elements?: Array<Record<string, unknown>>;
  env?: { ids?: string[]; randoms?: number[] };
  events: SessionEvent[];
}

const SESSION_CASES: SessionCase[] = [
  {
    name: 'a reset output clears its element even when the part returns none',
    operations: [
      {
        id: 'op-add',
        operationName: 'counter.add',
        inputs: [{ name: 'key', source: 'constant', sourceId: 'total' }],
        outputs: [{ name: 'reset', target: 'ui-element', targetId: 'amount-in' }],
      },
    ],
    events: [
      { do: 'setElement', elementId: 'amount-in', value: '42' },
      { do: 'chain', operationIds: ['op-add'] },
    ],
  },
  {
    name: 'entry flow: element reads, input transform, reset outputs, mirrors',
    operations: [
      {
        id: 'op-add',
        operationName: 'list.append',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'expenses' },
          { name: 'item.description', source: 'ui-element', sourceId: 'desc-in' },
          {
            name: 'item.amount',
            source: 'ui-element',
            sourceId: 'amt-in',
            transforms: [{ type: 'parseNumber', parameters: {} }],
          },
        ],
        outputs: [
          { name: 'reset', target: 'ui-element', targetId: 'desc-in' },
          { name: 'reset', target: 'ui-element', targetId: 'amt-in' },
        ],
      },
    ],
    env: { ids: ['gen-1'] },
    events: [
      { do: 'setElement', elementId: 'desc-in', value: 'lunch' },
      { do: 'setElement', elementId: 'amt-in', value: '12.5' },
      { do: 'chain', operationIds: ['op-add'] },
    ],
  },
  {
    name: 'typed constants: present null value wins over sourceId',
    operations: [
      {
        id: 'op-flag',
        operationName: 'state.set',
        executionType: 'builtin',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'running' },
          { name: 'value', source: 'constant', sourceId: 'true', value: true },
        ],
        outputs: [],
      },
      {
        id: 'op-null',
        operationName: 'state.set',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'cleared' },
          { name: 'value', source: 'constant', sourceId: 'ignored', value: null },
        ],
        outputs: [],
      },
      {
        id: 'op-step',
        operationName: 'counter.add',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'clicks' },
          { name: 'amount', source: 'state', sourceId: 'step' },
        ],
        outputs: [],
      },
    ],
    initialState: { step: 5 },
    events: [{ do: 'chain', operationIds: ['op-flag', 'op-null', 'op-step'] }],
  },
  {
    name: 'item scope delete',
    operations: [
      {
        id: 'op-del',
        operationName: 'list.removeWhere',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'rows' },
          { name: 'value', source: 'item', sourceId: 'id' },
        ],
        outputs: [],
      },
    ],
    initialState: {
      rows: [
        { id: 'a', title: 'x' },
        { id: 'b', title: 'y' },
      ],
    },
    events: [{ do: 'chain', operationIds: ['op-del'], item: { id: 'a', title: 'x' } }],
  },
  {
    name: 'live parameter reference in an input pipeline',
    operations: [
      {
        id: 'op-count',
        operationName: 'state.set',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'matches' },
          {
            name: 'value',
            source: 'state',
            sourceId: 'rows',
            transforms: [
              {
                type: 'filterBy',
                parameters: { field: 'category', value: { source: 'element', sourceId: 'cat-in' } },
              },
              { type: 'count', parameters: {} },
            ],
          },
        ],
        outputs: [],
      },
    ],
    initialState: {
      rows: [
        { id: 'a', category: 'food' },
        { id: 'b', category: 'travel' },
        { id: 'c', category: 'food' },
      ],
    },
    events: [
      { do: 'setElement', elementId: 'cat-in', value: 'food' },
      { do: 'chain', operationIds: ['op-count'] },
    ],
  },
  {
    name: 'a failed operation stops its chain',
    operations: [
      {
        id: 'op-pick',
        operationName: 'random.pick',
        inputs: [{ name: 'list', source: 'state', sourceId: 'options' }],
        outputs: [{ name: 'value', target: 'state', targetId: 'chosen' }],
      },
      {
        id: 'op-mark',
        operationName: 'state.set',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'picked' },
          { name: 'value', source: 'constant', sourceId: 'yes' },
        ],
        outputs: [],
      },
    ],
    events: [{ do: 'chain', operationIds: ['op-pick', 'op-mark'] }],
  },
  {
    name: 'output transforms run without live context',
    operations: [
      {
        id: 'op-sum',
        operationName: 'math.add',
        inputs: [
          { name: 'a', source: 'constant', sourceId: '2', value: 2 },
          { name: 'b', source: 'constant', sourceId: '3', value: 3 },
        ],
        outputs: [
          {
            name: 'result',
            target: 'state',
            targetId: 'total',
            transforms: [{ type: 'format', parameters: { template: 'Sum: {{value}}' } }],
          },
          {
            name: 'result',
            target: 'state',
            targetId: 'same',
            transforms: [
              { type: 'equals', parameters: { value: { source: 'state', sourceId: 'total' } } },
            ],
          },
        ],
      },
    ],
    events: [{ do: 'chain', operationIds: ['op-sum'] }],
  },
  {
    name: 'a missing output name routes the whole result',
    operations: [
      {
        id: 'op-set',
        operationName: 'state.set',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'mode' },
          { name: 'value', source: 'constant', sourceId: 'dark' },
        ],
        outputs: [{ name: 'ghost', target: 'state', targetId: 'copy' }],
      },
    ],
    events: [{ do: 'chain', operationIds: ['op-set'] }],
  },
  {
    name: 'ui-element property output merges a sub-object',
    operations: [
      {
        id: 'op-note',
        operationName: 'state.set',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'saved' },
          { name: 'value', source: 'constant', sourceId: 'ok' },
        ],
        outputs: [{ name: 'value', target: 'ui-element', targetId: 'status', property: 'text' }],
      },
    ],
    events: [
      { do: 'setElement', elementId: 'status', value: 'plain' },
      { do: 'chain', operationIds: ['op-note'] },
    ],
  },
  {
    name: 'element defaults seed and feed inputs',
    operations: [
      {
        id: 'op-copy',
        operationName: 'state.set',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'greeting' },
          { name: 'value', source: 'ui-element', sourceId: 'name-in' },
        ],
        outputs: [],
      },
    ],
    elements: [
      {
        id: 'wrap',
        type: 'container',
        children: [{ id: 'name-in', type: 'input', properties: { defaultValue: 'hello' } }],
      },
    ],
    events: [{ do: 'chain', operationIds: ['op-copy'] }],
  },
];

/** JSON-value semantics: undefined normalizes to null, matching what any
 * renderer boundary serialization would produce. */
function jsonNormalize(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value ?? null));
}

/** Runs one operation case against the shipped builtins with scripted ids,
 * randomness, and clock, returning the frozen expectation. */
function runOperationCase(entry: OperationCase) {
  const def = BUILTIN_OPERATIONS[entry.operation];
  if (!def) throw new Error(`No builtin ${entry.operation}`);

  const env = {
    ids: entry.env?.ids ?? [],
    randoms: entry.env?.randoms ?? [],
    epochMs: FIXED_EPOCH_MS,
  };
  const reply = kcall('capture.operation', {
    name: entry.operation,
    inputs: jsonNormalize(entry.inputs),
    state: jsonNormalize(entry.state),
    env,
  }) as { state: Record<string, unknown>; outputs?: Record<string, unknown>; error?: string };

  if (reply.error !== undefined) {
    return {
      name: entry.name,
      operation: entry.operation,
      inputs: jsonNormalize(entry.inputs),
      state: jsonNormalize(entry.state),
      env,
      shapeOnlyOutputs: [],
      error: true,
      expected: { state: jsonNormalize(entry.state), outputs: {} },
    };
  }
  const frozenOutputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(reply.outputs ?? {})) {
    if (!entry.shapeOnlyOutputs?.includes(name)) {
      frozenOutputs[name] = value;
    }
  }
  return {
    name: entry.name,
    operation: entry.operation,
    inputs: jsonNormalize(entry.inputs),
    state: jsonNormalize(entry.state),
    env,
    shapeOnlyOutputs: entry.shapeOnlyOutputs ?? [],
    error: false,
    expected: { state: reply.state, outputs: frozenOutputs },
  };
}

const ENTRY_ROW_DEF: UiFragmentDef = {
  name: 'basics.entry_row',
  description: 'entry row',
  params: [
    { name: 'label', type: 'string', required: true },
    { name: 'placeholder', type: 'string', default: '' },
    { name: 'buttonText', type: 'string', default: 'Add' },
    { name: 'operationId', type: 'operationId', required: true },
  ],
  template: {
    id: '{{id}}-row',
    type: 'container',
    properties: { direction: 'row', gap: '8', align: 'end' },
    children: [
      {
        id: '{{id}}-input',
        type: 'input',
        properties: { label: '{{label}}', placeholder: '{{placeholder}}' },
      },
      {
        id: '{{id}}-btn',
        type: 'button',
        properties: { text: '{{buttonText}}', variant: 'primary' },
        eventBindings: [{ event: 'click', operationId: '{{operationId}}' }],
      },
    ],
  },
};

const MINI_PACK_DEF: UiFragmentDef = {
  name: 'basics.ticker',
  description: 'self-wired ticker',
  params: [{ name: 'label', type: 'string', default: 'Ticker' }],
  template: {
    id: '{{id}}-box',
    type: 'container',
    children: [
      {
        id: '{{id}}-display',
        type: 'text',
        dataBindings: [
          {
            property: 'content',
            source: 'state',
            sourceId: '{{id}}-count',
            transforms: [{ type: 'format', parameters: { template: '{{label}}: {{value}}' } }],
          },
        ],
      },
      {
        id: '{{id}}-btn',
        type: 'button',
        properties: { text: 'Tick' },
        eventBindings: [{ event: 'click', operationId: '{{id}}-step' }],
      },
    ],
  },
  operations: [
    {
      id: '{{id}}-step',
      operationName: 'counter.add',
      implementation: { type: 'remote', endpoint: 'https://example.com' },
      inputs: [{ name: 'key', source: 'constant', sourceId: '{{id}}-count' }],
    },
  ],
};

interface TemplateCase {
  name: string;
  kind: 'fragment' | 'packOperations';
  def: UiFragmentDef;
  instance: Record<string, unknown>;
}

const TEMPLATE_CASES: TemplateCase[] = [
  {
    name: 'entry row expands with defaults, params, and id scoping',
    kind: 'fragment',
    def: ENTRY_ROW_DEF,
    instance: {
      id: 'task-entry',
      type: 'basics.entry_row',
      properties: { label: 'New task', operationId: 'op-add' },
      visibleWhen: { source: 'state', sourceId: 'editing', operator: 'truthy' },
    },
  },
  {
    name: 'exact placeholders keep parameter types',
    kind: 'fragment',
    def: {
      name: 'basics.gauge',
      description: 'gauge',
      params: [
        { name: 'max', type: 'number', default: 100 },
        { name: 'active', type: 'boolean', default: true },
      ],
      template: {
        id: '{{id}}-gauge',
        type: 'progress',
        properties: { max: '{{max}}', active: '{{active}}', hint: 'up to {{max}}' },
      },
    },
    instance: { id: 'g1', type: 'basics.gauge', properties: { max: 10 } },
  },
  {
    name: 'unmatched placeholders survive substitution',
    kind: 'fragment',
    def: MINI_PACK_DEF,
    instance: { id: 'tick1', type: 'basics.ticker', properties: {} },
  },
  {
    name: 'pack operations instantiate per use and drop implementations',
    kind: 'packOperations',
    def: MINI_PACK_DEF,
    instance: { id: 'tick1', type: 'basics.ticker', properties: {} },
  },
];

interface ViewCase {
  name: string;
  elements: Array<Record<string, unknown>>;
  state: Record<string, unknown>;
  fragmentDefs?: Record<string, UiFragmentDef>;
}

const VIEW_ROWS_STATE = {
  rows: [
    { id: 'a', title: 'Bolt', qty: 4, done: true },
    { id: null, title: 'Washer', qty: 10 },
    { title: 'Tape', qty: 3 },
  ],
};

const VIEW_CASES: ViewCase[] = [
  {
    name: 'binding sources resolve and undefined props stay absent',
    elements: [
      {
        id: 'panel',
        type: 'container',
        properties: { padding: '8', stale: 'shadowed' },
        dataBindings: [
          { property: 'a', source: 'state', sourceId: 'greeting' },
          { property: 'b', source: 'operation', sourceId: 'op-1' },
          { property: 'c', source: 'constant', sourceId: 'true', value: true },
          { property: 'd', source: 'constant', sourceId: 'plain' },
          { property: 'e', source: 'unknown-source', sourceId: 'x' },
          { property: 'stale', source: 'state', sourceId: 'missing' },
        ],
      },
    ],
    state: { greeting: 'hi', 'operation_op-1': { value: 7 } },
  },
  {
    name: 'list rows resolve item scopes, keys, and event items',
    elements: [
      {
        id: 'rows',
        type: 'list',
        properties: { emptyText: 'Nothing yet' },
        dataBindings: [{ property: 'items', source: 'state', sourceId: 'rows' }],
        children: [
          {
            id: 'r-title',
            type: 'text',
            dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
          },
          {
            id: 'r-flag',
            type: 'text',
            visibleWhen: { source: 'item', sourceId: 'done', operator: 'truthy' },
            properties: { content: 'done' },
          },
          {
            id: 'r-del',
            type: 'button',
            properties: { text: 'Delete' },
            eventBindings: [{ event: 'click', operationId: 'op-del' }],
          },
        ],
      },
    ],
    state: VIEW_ROWS_STATE,
  },
  {
    name: 'an empty list keeps its rows empty and its emptyText prop',
    elements: [
      {
        id: 'rows',
        type: 'list',
        properties: { emptyText: 'Nothing yet' },
        dataBindings: [{ property: 'items', source: 'state', sourceId: 'rows' }],
        children: [{ id: 'r-t', type: 'text' }],
      },
    ],
    state: {},
  },
  {
    name: 'live lookup filters through an element reference',
    elements: [
      { id: 'search-in', type: 'input', properties: { label: 'Search' } },
      {
        id: 'hits',
        type: 'text',
        dataBindings: [
          {
            property: 'content',
            source: 'state',
            sourceId: 'rows',
            transforms: [
              {
                type: 'filterContains',
                parameters: { field: 'title', value: { source: 'element', sourceId: 'search-in' } },
              },
              { type: 'count', parameters: {} },
            ],
          },
        ],
      },
    ],
    state: { ...VIEW_ROWS_STATE, 'element_search-in': 'bo' },
  },
  {
    name: 'controls read state, defaults, and checkbox booleans',
    elements: [
      { id: 'name-in', type: 'input', properties: { defaultValue: 'hello' } },
      { id: 'qty-in', type: 'input' },
      { id: 'done-in', type: 'checkbox' },
      { id: 'cat-in', type: 'select', properties: { options: ['a', 'b'] } },
    ],
    state: { 'element_qty-in': '42', 'element_done-in': 'yes' },
  },
  {
    name: 'visibility distinguishes missing from null in comparisons',
    elements: [
      {
        id: 'gt-missing',
        type: 'text',
        properties: { content: 'never' },
        visibleWhen: { source: 'state', sourceId: 'ghost', operator: 'gt', value: -1 },
      },
      {
        id: 'gt-null',
        type: 'text',
        properties: { content: 'shows' },
        visibleWhen: { source: 'state', sourceId: 'zeroed', operator: 'gt', value: -1 },
      },
      {
        id: 'and-gate',
        type: 'text',
        properties: { content: 'both' },
        visibleWhen: [
          { source: 'state', sourceId: 'mode', operator: 'equals', value: 'on' },
          {
            source: 'state',
            sourceId: 'rows',
            operator: 'gt',
            value: 2,
            transforms: [{ type: 'count', parameters: {} }],
          },
        ],
      },
    ],
    state: { zeroed: null, mode: 'on', ...VIEW_ROWS_STATE },
  },
  {
    name: 'condition values resolve reference objects like transform params',
    elements: [
      {
        id: 'const-ref',
        type: 'text',
        properties: { content: 'typed zero' },
        visibleWhen: {
          source: 'state',
          sourceId: 'pages',
          operator: 'gt',
          value: { source: 'constant', sourceId: '0', value: 0 },
        },
      },
      {
        id: 'state-ref',
        type: 'text',
        properties: { content: 'beats limit' },
        visibleWhen: {
          source: 'state',
          sourceId: 'pages',
          operator: 'gte',
          value: { source: 'state', sourceId: 'limit' },
        },
      },
      {
        id: 'element-ref',
        type: 'text',
        properties: { content: 'matches picked' },
        visibleWhen: {
          source: 'state',
          sourceId: 'mode',
          operator: 'equals',
          value: { source: 'element', sourceId: 'mode-in' },
        },
      },
      {
        id: 'missing-ref',
        type: 'text',
        properties: { content: 'never' },
        visibleWhen: {
          source: 'state',
          sourceId: 'pages',
          operator: 'gt',
          value: { source: 'state', sourceId: 'ghost-limit' },
        },
      },
    ],
    state: { pages: 3, limit: 2, mode: 'dark', 'element_mode-in': 'dark' },
  },
  {
    name: 'fragment instances expand and resolve against state',
    elements: [
      {
        id: 'task-entry',
        type: 'basics.entry_row',
        properties: { label: 'New task', operationId: 'op-add' },
        visibleWhen: { source: 'state', sourceId: 'editing', operator: 'truthy' },
      },
      {
        id: 'tick1',
        type: 'basics.ticker',
        properties: { label: 'Steps' },
      },
    ],
    state: { editing: 1, 'tick1-count': 5 },
    fragmentDefs: { 'basics.entry_row': ENTRY_ROW_DEF, 'basics.ticker': MINI_PACK_DEF },
  },
  {
    name: 'events keep contract order per event',
    elements: [
      {
        id: 'go-btn',
        type: 'button',
        properties: { text: 'Go' },
        eventBindings: [
          { event: 'click', operationId: 'op-first' },
          { event: 'click', operationId: 'op-second' },
          { event: 'focus', operationId: 'op-note' },
        ],
      },
      {
        id: 'clock',
        type: 'timer',
        eventBindings: [{ event: 'tick', operationId: 'op-advance' }],
      },
    ],
    state: {},
  },
];

// A realistic compose response with multibyte text; cut points across it
// exercise every recovery path (mid-string, mid-number, dangling keys and
// separators, half-open arrays).
const STREAM_FULL = JSON.stringify({
  spec: { goal: 'Track dueler scores', assumptions: [], openQuestions: [] },
  contract: {
    name: 'skor-takibi',
    version: '1.0.0',
    styling: { theme: 'dark', accent: 'green' },
    elements: [
      {
        id: 'title',
        type: 'text',
        properties: { content: 'Skor Takibi Üst Düzey', role: 'title' },
      },
      {
        id: 'rows',
        type: 'list',
        properties: { emptyText: 'Henüz yok' },
        dataBindings: [
          {
            property: 'items',
            source: 'state',
            sourceId: 'scores',
            transforms: [
              { type: 'sortBy', parameters: { field: 'points', direction: 'desc' } },
              { type: 'imaginary', parameters: {} },
            ],
          },
        ],
        children: [
          {
            id: 'r-name',
            type: 'text',
            dataBindings: [{ property: 'content', source: 'item', sourceId: 'name' }],
          },
          {
            id: 'r-pts',
            type: 'text',
            dataBindings: [
              {
                property: 'content',
                source: 'item',
                sourceId: 'points',
                transforms: [{ type: 'formatNumber', parameters: { decimals: 0 } }],
              },
            ],
          },
        ],
      },
      {
        id: 'add-btn',
        type: 'button',
        properties: { text: 'Ekle', variant: 'primary' },
        eventBindings: [{ event: 'click', operationId: 'op-add' }],
      },
    ],
    operations: [
      {
        id: 'op-add',
        operationName: 'list.append',
        inputs: [
          { name: 'key', source: 'constant', sourceId: 'scores' },
          { name: 'item.points', source: 'ui-element', sourceId: 'pts-in', value: 12.5 },
        ],
      },
    ],
  },
});

interface StreamingCase {
  name: string;
  raw: string;
}

const STREAMING_CASES: StreamingCase[] = [
  { name: 'no object yet', raw: 'Sure, here is' },
  { name: 'empty input', raw: '' },
  { name: 'open brace only', raw: '{' },
  { name: 'spec only, no elements', raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('"elements"')) },
  {
    name: 'first element mid-string',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('Takibi') + 4),
  },
  {
    name: 'cut inside a multibyte word',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('Düzey') + 1),
  },
  {
    name: 'dangling key after comma',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('"role"') + 6),
  },
  {
    name: 'dangling colon takes null',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('"role"') + 7),
  },
  {
    name: 'mid-number backs up',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('12.5') + 2),
  },
  {
    name: 'transform list half open keeps known steps',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('"imaginary"') + 3),
  },
  {
    name: 'unknown transform dropped when complete',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf("'op-add'")),
  },
  {
    name: 'row template children accumulate',
    raw: STREAM_FULL.slice(0, STREAM_FULL.indexOf('"r-pts"') + 7),
  },
  { name: 'complete response', raw: STREAM_FULL },
  {
    name: 'bare contract without the compose envelope',
    raw: '{ "name": "düz", "elements": [ { "id": "a", "type": "text", "properties": { "content": "x" } }, { "id": "", "type": "text" }, { "type": "text" } ], "unknown": tru',
  },
  {
    name: 'escape cut at the backslash',
    raw: '{ "contract": { "elements": [ { "id": "a", "type": "text", "properties": { "content": "say \\"hi\\',
  },
  {
    name: 'styling passes through whole',
    raw: '{ "contract": { "name": "s", "styling": { "theme": "paper", "custom": 1 }, "elements": [ { "id": "a", "type": "text" } ] } }',
  },
];

// Contract fixtures for the validation port, scoped to the structural
// spine: every fixture keeps unrelated rule families silent (operations
// wired, appends displayed, controls consumed) so a partial Rust port can
// reach zero diff family by family.
interface ValidationCase {
  name: string;
  contract: Record<string, unknown>;
  fragmentDefs?: Record<string, UiFragmentDef>;
  partOperations?: Record<
    string,
    {
      inputs: Array<{ name: string; type: string; required?: boolean; description?: string }>;
      outputs: Array<{ name: string }>;
      structuredPrefixes?: string[];
    }
  >;
  credentials?: IntegrationCredentialView[];
}

const WIRED_COUNTER = {
  id: 'op-add',
  operationName: 'counter.add',
  inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }],
  outputs: [],
};

const COUNT_TEXT = {
  id: 'count-text',
  type: 'text',
  dataBindings: [{ property: 'content', source: 'state', sourceId: 'clicks' }],
};

const ADD_BTN = {
  id: 'add-btn',
  type: 'button',
  properties: { text: 'Add' },
  eventBindings: [{ event: 'click', operationId: 'op-add' }],
};

const VALIDATION_CASES: ValidationCase[] = [
  {
    name: 'a wired counter passes clean with an items seed',
    contract: {
      name: 'clean',
      elements: [COUNT_TEXT, ADD_BTN],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'unknown styling normalizes with warnings',
    contract: {
      name: 'styled',
      styling: { theme: 'vaporwave', accent: 'chartreuse' },
      elements: [COUNT_TEXT, ADD_BTN],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'a hex accent is vocabulary and survives untouched',
    contract: {
      name: 'styled-hex',
      styling: { theme: 'dark', accent: '#7c3aed' },
      elements: [COUNT_TEXT, ADD_BTN],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'a hex background survives and a malformed one normalizes away',
    contract: {
      name: 'styled-bg',
      styling: { background: '#fef9c3' },
      elements: [COUNT_TEXT, ADD_BTN],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'a non-hex background is removed with a warning',
    contract: {
      name: 'styled-bad-bg',
      styling: { background: 'sunny' },
      elements: [COUNT_TEXT, ADD_BTN],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'an event referencing a missing operation fails with the id list',
    contract: {
      name: 'missing-ref',
      elements: [
        COUNT_TEXT,
        {
          id: 'go-btn',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [{ event: 'click', operationId: 'op-ghost' }],
        },
        ADD_BTN,
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'events without any operations array get the outright fix first',
    contract: {
      name: 'no-ops',
      elements: [
        {
          id: 'go-btn',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [{ event: 'click', operationId: 'op-ghost' }],
        },
      ],
      operations: [],
    },
  },
  {
    name: 'an unknown operation name with no endpoint fails',
    contract: {
      name: 'unknown-op',
      elements: [
        COUNT_TEXT,
        {
          id: 'go-btn',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [{ event: 'click', operationId: 'op-cast' }],
        },
      ],
      operations: [{ id: 'op-cast', operationName: 'wizardry.cast', inputs: [], outputs: [] }],
    },
  },
  {
    name: 'an operation nothing runs is an orphan',
    contract: {
      name: 'orphan',
      elements: [COUNT_TEXT, ADD_BTN],
      operations: [
        WIRED_COUNTER,
        {
          id: 'op-idle',
          operationName: 'state.set',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'mode' },
            { name: 'value', source: 'constant', sourceId: 'x' },
          ],
          outputs: [],
        },
      ],
    },
  },
  {
    name: 'a control nothing consumes is dead',
    contract: {
      name: 'dead-control',
      elements: [
        COUNT_TEXT,
        ADD_BTN,
        { id: 'lonely-in', type: 'input', properties: { label: 'Lonely' } },
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'read but unwritten keys seed by reader shape',
    contract: {
      name: 'seeds',
      elements: [
        {
          id: 'rows',
          type: 'list',
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'entries' }],
        },
        {
          id: 'note',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'motto' }],
        },
        COUNT_TEXT,
        ADD_BTN,
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'unknown transforms and bad param refs fail structurally',
    contract: {
      name: 'pipeline-errors',
      elements: [
        {
          id: 'a-text',
          type: 'text',
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'rows',
              transforms: [
                { type: 'reverse', parameters: {} },
                {
                  type: 'filterBy',
                  parameters: { field: 'x', value: { source: 'cosmic', sourceId: 'y' } },
                },
                {
                  type: 'filterBy',
                  parameters: { field: 'x', value: { source: 'element', sourceId: 'ghost-in' } },
                },
                { type: 'count', parameters: {} },
              ],
            },
          ],
        },
        COUNT_TEXT,
        ADD_BTN,
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'a live element reference consumes the control',
    contract: {
      name: 'live-search',
      elements: [
        { id: 'search-in', type: 'input', properties: { label: 'Search' } },
        {
          id: 'hits',
          type: 'text',
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'rows',
              transforms: [
                {
                  type: 'filterContains',
                  parameters: {
                    field: 'title',
                    value: { source: 'element', sourceId: 'search-in' },
                  },
                },
                { type: 'count', parameters: {} },
              ],
            },
          ],
        },
        COUNT_TEXT,
        ADD_BTN,
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'display pipelines cannot end in a list and inputs cannot bind values',
    contract: {
      name: 'display-shape',
      elements: [
        {
          id: 'bad-text',
          type: 'text',
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'rows',
              transforms: [{ type: 'filterTruthy', parameters: { field: 'done' } }],
            },
          ],
        },
        {
          id: 'bad-in',
          type: 'input',
          properties: { label: 'Bound' },
          dataBindings: [{ property: 'value', source: 'state', sourceId: 'draft' }],
          eventBindings: [{ event: 'change', operationId: 'op-add' }],
        },
        {
          id: 'floating',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
          visibleWhen: { source: 'item', sourceId: 'done', operator: 'truthy' },
        },
        COUNT_TEXT,
        ADD_BTN,
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'invalid knob values normalize to their defaults',
    contract: {
      name: 'knobs',
      elements: [
        { id: 'loud', type: 'text', properties: { role: 'shouting', content: 'hi' } },
        {
          id: 'big-btn',
          type: 'button',
          properties: { text: 'Go', variant: 'rainbow', size: 'lg' },
          eventBindings: [{ event: 'click', operationId: 'op-add' }],
        },
        COUNT_TEXT,
      ],
      operations: [WIRED_COUNTER],
    },
  },
  {
    name: 'list reads of unwritten fields fail with the derive hint',
    contract: {
      name: 'unwritten-field',
      elements: [
        { id: 'name-in', type: 'input', properties: { label: 'Name' } },
        { id: 'qty-in', type: 'input', properties: { label: 'Qty' } },
        {
          id: 'add2-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add-row' }],
        },
        {
          id: 'rows',
          type: 'list',
          dataBindings: [
            {
              property: 'items',
              source: 'state',
              sourceId: 'entries',
              transforms: [{ type: 'sortBy', parameters: { field: 'total' } }],
            },
          ],
          children: [
            {
              id: 'r-name',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'name' }],
            },
          ],
        },
      ],
      operations: [
        {
          id: 'op-add-row',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'entries' },
            { name: 'item.name', source: 'ui-element', sourceId: 'name-in' },
            { name: 'item.qty', source: 'ui-element', sourceId: 'qty-in' },
          ],
          outputs: [],
        },
      ],
    },
  },
  {
    name: 'a filter fed by its own entry control fails',
    contract: {
      name: 'entry-filter',
      elements: [
        { id: 'title-in', type: 'input', properties: { label: 'Title' } },
        {
          id: 'add2-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add-row' }],
        },
        {
          id: 'rows',
          type: 'list',
          dataBindings: [
            {
              property: 'items',
              source: 'state',
              sourceId: 'entries',
              transforms: [
                {
                  type: 'filterContains',
                  parameters: {
                    field: 'title',
                    value: { source: 'element', sourceId: 'title-in' },
                  },
                },
              ],
            },
          ],
          children: [
            {
              id: 'r-t',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
            },
          ],
        },
      ],
      operations: [
        {
          id: 'op-add-row',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'entries' },
            { name: 'item.title', source: 'ui-element', sourceId: 'title-in' },
          ],
          outputs: [],
        },
      ],
    },
  },
  {
    name: 'derive expressions validate syntax and identifiers in place',
    contract: {
      name: 'derive-checks',
      elements: [
        { id: 'qty-in', type: 'input', properties: { label: 'Qty' } },
        {
          id: 'add2-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add-row' }],
        },
        {
          id: 'rows',
          type: 'list',
          dataBindings: [
            {
              property: 'items',
              source: 'state',
              sourceId: 'entries',
              transforms: [
                { type: 'deriveField', parameters: { field: 'value', expression: 'qty * price' } },
              ],
            },
          ],
          children: [
            {
              id: 'r-v',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'value' }],
            },
          ],
        },
        {
          id: 'broken',
          type: 'text',
          dataBindings: [
            {
              property: 'content',
              source: 'state',
              sourceId: 'entries',
              transforms: [
                { type: 'deriveField', parameters: { field: 'v', expression: 'qty +' } },
                { type: 'sum', parameters: { field: 'v' } },
              ],
            },
          ],
        },
      ],
      operations: [
        {
          id: 'op-add-row',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'entries' },
            { name: 'item.qty', source: 'ui-element', sourceId: 'qty-in' },
          ],
          outputs: [],
        },
      ],
    },
  },
  {
    name: 'list edits on unfilled keys and undisplayed appends fail',
    contract: {
      name: 'list-rules',
      elements: [
        { id: 'title-in', type: 'input', properties: { label: 'Title' } },
        {
          id: 'add2-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add-row' }],
        },
        {
          id: 'del-btn',
          type: 'button',
          properties: { text: 'Clear' },
          eventBindings: [{ event: 'click', operationId: 'op-del' }],
        },
      ],
      operations: [
        {
          id: 'op-add-row',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'entries' },
            { name: 'item.title', source: 'ui-element', sourceId: 'title-in' },
          ],
          outputs: [],
        },
        {
          id: 'op-del',
          operationName: 'list.removeWhere',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'archive' },
            { name: 'value', source: 'constant', sourceId: 'x' },
          ],
          outputs: [],
        },
      ],
    },
  },
  {
    name: 'operation inputs validate names, prefixes, and duplicates',
    contract: {
      name: 'op-inputs',
      elements: [
        COUNT_TEXT,
        {
          id: 'go-btn',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [
            { event: 'click', operationId: 'op-bad-flat' },
            { event: 'click', operationId: 'op-bad-prefix' },
            { event: 'click', operationId: 'op-missing' },
            { event: 'click', operationId: 'op-dup' },
            { event: 'click', operationId: 'op-bad-out' },
          ],
        },
      ],
      operations: [
        {
          id: 'op-bad-flat',
          operationName: 'counter.add',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'clicks' },
            { name: 'delta', source: 'constant', sourceId: '2' },
          ],
          outputs: [],
        },
        {
          id: 'op-bad-prefix',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'clicks' },
            { name: 'row.title', source: 'constant', sourceId: 'x' },
          ],
          outputs: [],
        },
        { id: 'op-missing', operationName: 'state.set', inputs: [], outputs: [] },
        {
          id: 'op-dup',
          operationName: 'counter.add',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'clicks' },
            { name: 'amount', source: 'constant', sourceId: '1', value: 1 },
            { name: 'amount', source: 'constant', sourceId: '2', value: 2 },
          ],
          outputs: [],
        },
        {
          id: 'op-bad-out',
          operationName: 'counter.add',
          inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }],
          outputs: [{ name: 'total', target: 'state', targetId: 'copy' }],
        },
      ],
    },
  },
  {
    name: 'expr expressions must bind every identifier',
    contract: {
      name: 'expr-lint',
      elements: [
        { id: 'x-in', type: 'input', properties: { label: 'X' } },
        {
          id: 'go-btn',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [{ event: 'click', operationId: 'op-calc' }],
        },
        {
          id: 'result',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'answer' }],
        },
      ],
      operations: [
        {
          id: 'op-calc',
          operationName: 'expr.evaluate',
          inputs: [
            { name: 'expression', source: 'constant', sourceId: 'x * rate + 1' },
            { name: 'var.x', source: 'ui-element', sourceId: 'x-in' },
          ],
          outputs: [{ name: 'value', target: 'state', targetId: 'answer' }],
        },
      ],
    },
    partOperations: {
      'expr.evaluate': {
        inputs: [
          { name: 'expression', type: 'string', required: true },
          { name: 'var.<name>', type: 'number', required: false },
        ],
        outputs: [{ name: 'value' }],
        structuredPrefixes: ['var'],
      },
    },
  },
  {
    name: 'numeric part inputs demand a projection from object lists',
    contract: {
      name: 'projection',
      elements: [
        { id: 'title-in', type: 'input', properties: { label: 'Title' } },
        {
          id: 'add2-btn',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [
            { event: 'click', operationId: 'op-add-row' },
            { event: 'click', operationId: 'op-stats' },
          ],
        },
        {
          id: 'rows',
          type: 'list',
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'entries' }],
          children: [
            {
              id: 'r-t',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
            },
          ],
        },
        {
          id: 'mean',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'mean' }],
        },
      ],
      operations: [
        {
          id: 'op-add-row',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'entries' },
            { name: 'item.title', source: 'ui-element', sourceId: 'title-in' },
          ],
          outputs: [],
        },
        {
          id: 'op-stats',
          operationName: 'stats.summary',
          inputs: [{ name: 'values', source: 'state', sourceId: 'entries' }],
          outputs: [{ name: 'mean', target: 'state', targetId: 'mean' }],
        },
      ],
    },
    partOperations: {
      'stats.summary': {
        inputs: [
          { name: 'values', type: 'array', required: true, description: 'Numbers to summarize' },
        ],
        outputs: [
          { name: 'count' },
          { name: 'sum' },
          { name: 'mean' },
          { name: 'min' },
          { name: 'max' },
        ],
      },
    },
  },
  {
    name: 'placeholder endpoints and credential confinement fail',
    contract: {
      name: 'remote-rules',
      elements: [
        COUNT_TEXT,
        {
          id: 'go-btn',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [
            { event: 'click', operationId: 'op-placeholder' },
            { event: 'click', operationId: 'op-bad-auth' },
            { event: 'click', operationId: 'op-escaped' },
          ],
        },
      ],
      operations: [
        {
          id: 'op-placeholder',
          operationName: 'demo.fetch',
          implementation: { type: 'remote', endpoint: 'https://api.example.com/things' },
          inputs: [],
          outputs: [{ name: 'response', target: 'state', targetId: 'clicks' }],
        },
        {
          id: 'op-bad-auth',
          operationName: 'other.fetch',
          implementation: {
            type: 'remote',
            endpoint: 'https://real.service.dev/x',
            auth: 'ghostkey',
          },
          inputs: [],
          outputs: [],
        },
        {
          id: 'op-escaped',
          operationName: 'third.fetch',
          implementation: {
            type: 'remote',
            endpoint: 'https://elsewhere.dev/x',
            auth: 'weatherkey',
          },
          inputs: [],
          outputs: [],
        },
      ],
    },
    credentials: [
      {
        name: 'weatherkey',
        kind: 'query',
        target: 'appid',
        baseUrl: 'https://api.openweathermap.org',
      },
    ],
  },
  {
    name: 'non-http credential kinds are invisible to auth references',
    contract: {
      name: 'mail-auth',
      elements: [
        COUNT_TEXT,
        {
          id: 'send-btn',
          type: 'button',
          properties: { text: 'Send' },
          eventBindings: [{ event: 'click', operationId: 'op-mail-auth' }],
        },
      ],
      operations: [
        {
          id: 'op-mail-auth',
          operationName: 'notify.fetch',
          implementation: {
            type: 'remote',
            endpoint: 'https://hooks.example.dev/notify',
            auth: 'mail',
          },
          inputs: [],
          outputs: [{ name: 'response', target: 'state', targetId: 'clicks' }],
        },
      ],
    },
    credentials: [
      {
        name: 'mail',
        kind: 'smtp',
        fields: { host: 'smtp.example.net', security: 'starttls' },
      },
      {
        name: 'hooks-token',
        kind: 'bearer',
        baseUrl: 'https://hooks.example.dev',
      },
      {
        name: 'part:der-labs.mailer:api-key',
        kind: 'partsecret',
      },
    ],
  },
  {
    name: 'row reads validate against declared and appended row shapes',
    contract: {
      name: 'inbox-rows',
      elements: [
        {
          id: 'refresh-btn',
          type: 'button',
          properties: { text: 'Refresh' },
          eventBindings: [{ event: 'click', operationId: 'op-load' }],
        },
        {
          id: 'inbox-list',
          type: 'list',
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'inbox' }],
          children: [
            {
              id: 'row-sender',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'sender' }],
            },
            {
              id: 'row-subject',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'subject' }],
            },
            {
              id: 'row-open',
              type: 'button',
              properties: { text: 'Read' },
              eventBindings: [{ event: 'click', operationId: 'op-open' }],
            },
          ],
        },
        { id: 'todo-input', type: 'input', properties: { label: 'Task' } },
        {
          id: 'todo-add',
          type: 'button',
          properties: { text: 'Add' },
          eventBindings: [{ event: 'click', operationId: 'op-add-todo' }],
        },
        {
          id: 'todo-list',
          type: 'list',
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
          children: [
            {
              id: 'todo-label',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'label' }],
            },
          ],
        },
        {
          id: 'reader',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'open-text' }],
        },
      ],
      operations: [
        {
          id: 'op-load',
          operationName: 'email.list',
          inputs: [],
          outputs: [{ name: 'messages', target: 'state', targetId: 'inbox' }],
        },
        {
          id: 'op-open',
          operationName: 'email.fetch',
          inputs: [{ name: 'id', source: 'item', sourceId: 'uid' }],
          outputs: [{ name: 'text', target: 'state', targetId: 'open-text' }],
        },
        {
          id: 'op-add-todo',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'todos' },
            { name: 'item.title', source: 'ui-element', sourceId: 'todo-input' },
          ],
          outputs: [],
        },
      ],
    },
  },
  {
    name: 'fragment params enforce and packs validate through every rule',
    contract: {
      name: 'fragments',
      elements: [
        { id: 'entry', type: 'basics.entry_row', properties: { label: 'Task' } },
        { id: 'tick', type: 'basics.ticker', properties: {} },
        {
          id: 'rows',
          type: 'list',
          dataBindings: [{ property: 'items', source: 'state', sourceId: 'tasks' }],
          children: [
            {
              id: 'r-t',
              type: 'text',
              dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
            },
          ],
        },
      ],
      operations: [
        {
          id: 'op-add-task',
          operationName: 'list.append',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'tasks' },
            { name: 'item.title', source: 'ui-element', sourceId: 'entry-input' },
          ],
          outputs: [],
        },
      ],
    },
    fragmentDefs: {
      'basics.entry_row': ENTRY_ROW_DEF,
      'basics.ticker': {
        ...MINI_PACK_DEF,
        operations: [
          {
            id: '{{id}}-step',
            operationName: 'chrono.advance',
            inputs: [{ name: 'key', source: 'constant', sourceId: '{{id}}-count' }],
          },
        ],
      },
    },
  },
  {
    name: 'centered entry rows align to end',
    contract: {
      name: 'entry-row',
      elements: [
        {
          id: 'entry',
          type: 'container',
          properties: { direction: 'row', align: 'center' },
          children: [
            { id: 'what-in', type: 'input', properties: { label: 'What' } },
            {
              id: 'go-btn',
              type: 'button',
              properties: { text: 'Go' },
              eventBindings: [{ event: 'click', operationId: 'op-note' }],
            },
          ],
        },
        {
          id: 'note',
          type: 'text',
          dataBindings: [{ property: 'content', source: 'state', sourceId: 'note' }],
        },
      ],
      operations: [
        {
          id: 'op-note',
          operationName: 'state.set',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'note' },
            { name: 'value', source: 'ui-element', sourceId: 'what-in' },
          ],
          outputs: [],
        },
      ],
    },
  },
];

/** The registry snapshot the Rust core embeds: knob tables, builtin
 * operation shapes, transform kinds, style vocabulary, and the full
 * model-facing manifest text (descriptions, howtos, examples) the prompt
 * catalog renders from. Generated from the live TS registry so there is
 * one source of truth. */
function buildRegistrySnapshot() {
  const elements = Object.fromEntries(
    Object.entries(ELEMENT_MANIFESTS).map(([type, manifest]) => [
      type,
      {
        description: manifest.description,
        knobs: manifest.knobs.map((knob) => ({
          name: knob.name,
          type: knob.type,
          ...(knob.values ? { values: knob.values } : {}),
          ...(knob.default !== undefined ? { default: knob.default } : {}),
        })),
        ...(manifest.bindableProps?.length ? { bindableProps: manifest.bindableProps } : {}),
        howto: manifest.howto,
        ...(manifest.example !== undefined ? { example: manifest.example } : {}),
      },
    ])
  );
  const operations = Object.fromEntries(
    Object.entries(BUILTIN_OPERATIONS).map(([name, def]) => [
      name,
      {
        description: def.description,
        inputs: def.inputs.map((input) => ({
          name: input.name,
          type: input.type,
          ...(input.required !== undefined ? { required: input.required } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        })),
        outputs: def.outputs.map((output) => ({
          name: output.name,
          type: output.type,
          ...(output.itemFields ? { itemFields: output.itemFields } : {}),
        })),
        ...(def.structuredPrefixes ? { structuredPrefixes: def.structuredPrefixes } : {}),
        ...(def.howto !== undefined ? { howto: def.howto } : {}),
        ...(def.example !== undefined ? { example: def.example } : {}),
        ...(def.hidden ? { hidden: true } : {}),
      },
    ])
  );
  const transforms = Object.entries(TRANSFORMS).map(([name, def]) => ({
    name,
    output: def.output,
    description: def.description,
    parameters: def.parameters.map((param) => param.name),
  }));
  return {
    formatVersion: 1,
    elements,
    operations,
    transforms,
    styleThemes: ['default', 'dark', 'paper', 'terminal'],
    styleAccents: ['blue', 'green', 'violet', 'rose', 'amber', 'cyan'],
    exprReserved: ['sqrt', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'pow', 'pi', 'e'],
    intrinsicElements: [...INTRINSIC_ELEMENT_TYPES],
  };
}

function runValidationCase(entry: ValidationCase) {
  const contract = jsonNormalize(
    JSON.parse(JSON.stringify(ContractSchema.parse(entry.contract)))
  );
  const outcome = kcall('validate.check', {
    contract,
    fragmentDefs: jsonNormalize(entry.fragmentDefs ?? {}),
    partOperations: jsonNormalize(entry.partOperations ?? {}),
    credentials: jsonNormalize(entry.credentials ?? []),
  }) as { errors: unknown[]; warnings: unknown[]; contract: unknown };
  return {
    name: entry.name,
    contract,
    fragmentDefs: jsonNormalize(entry.fragmentDefs ?? {}),
    partOperations: jsonNormalize(entry.partOperations ?? {}),
    credentials: jsonNormalize(entry.credentials ?? []),
    expected: {
      errors: outcome.errors,
      warnings: outcome.warnings,
      mutated: outcome.contract,
    },
  };
}

// ---------------------------------------------------------------------------
// Compose orchestration vectors: prompt text, response acceptance, contract
// finalization, and the repair loop over a scripted model.
// ---------------------------------------------------------------------------

interface ComposePartOperationDef {
  description: string;
  inputs: Array<{ name: string; type: string; required?: boolean; description?: string }>;
  outputs: Array<{ name: string; type: string }>;
  structuredPrefixes?: string[];
  howto?: string;
  example?: Record<string, unknown>;
}

interface ComposeVocabulary {
  fragmentDefs?: Record<string, UiFragmentDef>;
  partOperations?: Record<string, ComposePartOperationDef>;
  credentials?: IntegrationCredentialView[];
  recipes?: Record<string, RecipeDef>;
}


function vocabularyEcho(vocab: ComposeVocabulary) {
  return {
    fragmentDefs: jsonNormalize(vocab.fragmentDefs ?? {}),
    partOperations: jsonNormalize(vocab.partOperations ?? {}),
    credentials: jsonNormalize(vocab.credentials ?? []),
    recipes: jsonNormalize(vocab.recipes ?? {}),
  };
}

const RECIPE_COUNTER_CONTRACT = {
  name: 'proven-counter',
  elements: [
    {
      id: 'count-text',
      type: 'text',
      dataBindings: [{ property: 'content', source: 'state', sourceId: 'clicks' }],
    },
    {
      id: 'add-btn',
      type: 'button',
      properties: { text: 'Add' },
      eventBindings: [{ event: 'click', operationId: 'op-add' }],
    },
  ],
  operations: [
    {
      id: 'op-add',
      operationName: 'counter.add',
      inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }],
    },
  ],
};

const GOOD_RECIPE: RecipeDef = {
  name: 'apps.proven_counter',
  title: 'Proven Counter',
  description: 'A counter that is already proven to work',
  keywords: ['counter', 'clicks'],
  spec: { goal: 'Count clicks' },
  contract: RECIPE_COUNTER_CONTRACT,
  partId: 'der-labs.starter-apps',
  publisher: 'der-labs',
};

const BROKEN_RECIPE: RecipeDef = {
  name: 'apps.broken_notes',
  title: 'Broken Notes',
  description: 'References vocabulary that is not installed',
  keywords: ['notes'],
  contract: {
    name: 'broken-notes',
    elements: [
      {
        id: 'note-btn',
        type: 'button',
        properties: { text: 'Note' },
        eventBindings: [{ event: 'click', operationId: 'op-note' }],
      },
    ],
    operations: [
      {
        id: 'op-note',
        operationName: 'chrono.advance',
        inputs: [],
      },
    ],
  },
  partId: 'der-labs.starter-apps',
  publisher: 'der-labs',
};

const COMPOSE_PART_OPERATIONS: Record<string, ComposePartOperationDef> = {
  'expr.evaluate': {
    description: 'Evaluates an arithmetic expression over bound variables',
    inputs: [
      { name: 'expression', type: 'string', required: true },
      { name: 'var.<name>', type: 'number', required: false },
    ],
    outputs: [{ name: 'value', type: 'number' }],
    structuredPrefixes: ['var'],
    howto: 'Bind each identifier with a var.<name> input.',
    example: {
      id: 'op-total',
      operationName: 'expr.evaluate',
      inputs: [
        { name: 'expression', source: 'constant', sourceId: 'a + b' },
        { name: 'var.a', source: 'state', sourceId: 'first' },
        { name: 'var.b', source: 'state', sourceId: 'second' },
      ],
    },
  },
  'stats.summary': {
    description: 'Summarizes a list of numbers',
    inputs: [
      { name: 'values', type: 'array', required: true, description: 'numbers to summarize' },
    ],
    outputs: [
      { name: 'mean', type: 'number' },
      { name: 'max', type: 'number' },
    ],
  },
};

const COMPOSE_CREDENTIALS: IntegrationCredentialView[] = [
  {
    name: 'openweather',
    kind: 'query',
    target: 'appid',
    baseUrl: 'https://api.openweathermap.org/',
    notes: 'Current weather at /data/2.5/weather?q={city}',
  },
  { name: 'github', kind: 'bearer', baseUrl: 'https://api.github.com/' },
  { name: 'newsdesk', kind: 'header', target: 'X-Api-Key' },
];

interface ComposePromptCase extends ComposeVocabulary {
  name: string;
  compact?: boolean;
}

const COMPOSE_PROMPT_CASES: ComposePromptCase[] = [
  { name: 'builtin vocabulary renders the base prompt', compact: true },
  {
    name: 'installed vocabulary renders every catalog section',
    fragmentDefs: { 'basics.entry_row': ENTRY_ROW_DEF, 'basics.ticker': MINI_PACK_DEF },
    partOperations: COMPOSE_PART_OPERATIONS,
    credentials: COMPOSE_CREDENTIALS,
    recipes: { 'apps.proven_counter': GOOD_RECIPE, 'apps.broken_notes': BROKEN_RECIPE },
  },
];

function runComposePromptCase(entry: ComposePromptCase) {
  const vocab = vocabularyEcho(entry);
  const expected: Record<string, unknown> = {
    base: kcall('capture.promptBase', { ...vocab, compact: false }).base,
  };
  if (entry.compact) {
    const sections = kcall('capture.promptSections');
    const compactBase = kcall('capture.promptBase', { ...vocab, compact: true }).base;
    expected.compactCreateSystem = `${compactBase}\n\n${sections.create}`;
  }
  return {
    name: entry.name,
    compact: entry.compact ?? false,
    ...vocab,
    expected,
  };
}

interface ComposeResponseCase extends ComposeVocabulary {
  name: string;
  schema: 'composed' | 'contract';
  raw: string;
  /** Engine-authored JSON.parse detail: freeze only our stable prefix. */
  problemPrefixOnly?: boolean;
}

const VALID_COMPOSED_RAW = JSON.stringify({
  spec: { goal: 'Count clicks', assumptions: ['Starts at zero'] },
  contract: RECIPE_COUNTER_CONTRACT,
});

const COMPOSE_RESPONSE_CASES: ComposeResponseCase[] = [
  {
    name: 'fenced response with prose parses and fills defaults',
    schema: 'composed',
    raw: `Here is the app you asked for:\n\`\`\`json\n${VALID_COMPOSED_RAW}\n\`\`\`\nEnjoy!`,
  },
  {
    name: 'prose without an object fails extraction',
    schema: 'composed',
    raw: 'Sorry, I cannot build that app.',
  },
  {
    name: 'an unbalanced object fails extraction',
    schema: 'composed',
    raw: '{"spec": {"goal": "x"',
  },
  {
    name: 'engine parse errors freeze as a prefix',
    schema: 'composed',
    raw: '{"spec": }',
    problemPrefixOnly: true,
  },
  {
    name: 'schema violations point at the offending fragment',
    schema: 'composed',
    raw: JSON.stringify({
      spec: { goal: 'Bad shapes' },
      contract: {
        name: 'bad',
        elements: [{ type: 'text' }],
        operations: [
          {
            id: 'op-x',
            operationName: 'state.set',
            implementation: { type: 'local', code: 'return 1' },
          },
        ],
      },
    }),
  },
  {
    name: 'the response must pick contract or recipe',
    schema: 'composed',
    raw: JSON.stringify({ spec: { goal: 'Neither' } }),
  },
  {
    name: 'the issue list caps at five',
    schema: 'composed',
    raw: JSON.stringify({
      spec: { goal: 'Too many problems' },
      contract: {
        name: 'bad',
        elements: [
          { type: 'text' },
          { type: 'text' },
          { type: 'text' },
          { type: 'text' },
          { type: 'text' },
          { type: 'text' },
        ],
      },
    }),
  },
  {
    name: 'semantic violations carry the checker messages',
    schema: 'composed',
    raw: JSON.stringify({
      spec: { goal: 'Ghost operation' },
      contract: {
        name: 'ghost',
        elements: [{ id: 'label', type: 'text', properties: { content: 'hi' } }],
        operations: [{ id: 'op-ghost', operationName: 'chrono.advance' }],
      },
    }),
  },
  {
    name: 'a recipe answer resolves against installed recipes',
    schema: 'composed',
    raw: JSON.stringify({
      spec: { goal: 'Count clicks', assumptions: ['Reusing the installed counter'] },
      recipe: 'apps.proven_counter',
    }),
    recipes: { 'apps.proven_counter': GOOD_RECIPE, 'apps.broken_notes': BROKEN_RECIPE },
  },
  {
    name: 'an unknown recipe repairs toward composing',
    schema: 'composed',
    raw: JSON.stringify({ spec: { goal: 'Count' }, recipe: 'apps.nope' }),
    recipes: { 'apps.proven_counter': GOOD_RECIPE, 'apps.broken_notes': BROKEN_RECIPE },
  },
  {
    name: 'a broken recipe cannot open and repairs toward composing',
    schema: 'composed',
    raw: JSON.stringify({ spec: { goal: 'Notes' }, recipe: 'apps.broken_notes' }),
    recipes: { 'apps.proven_counter': GOOD_RECIPE, 'apps.broken_notes': BROKEN_RECIPE },
  },
  {
    name: 'the contract schema accepts a plain contract',
    schema: 'contract',
    raw: JSON.stringify(RECIPE_COUNTER_CONTRACT),
  },
];

function runComposeResponseCase(entry: ComposeResponseCase) {
  const vocab = vocabularyEcho(entry);
  const verdict = kcall('capture.parseValidated', {
    ...vocab,
    schema: entry.schema,
    raw: entry.raw,
  }) as { ok: boolean; value?: unknown; problem?: string };
  const expected = verdict.ok
    ? { ok: true, value: verdict.value }
    : entry.problemPrefixOnly
      ? { ok: false, problemPrefix: 'The response was not parseable JSON:' }
      : { ok: false, problem: verdict.problem };
  return {
    name: entry.name,
    schema: entry.schema,
    raw: entry.raw,
    ...vocab,
    expected,
  };
}

interface ComposeFinalizeCase extends ComposeVocabulary {
  name: string;
  shape: Record<string, unknown>;
  description?: string;
}

const COMPOSE_FINALIZE_CASES: ComposeFinalizeCase[] = [
  {
    name: 'duplicate ids rename across the tree and operations',
    shape: {
      name: 'dupes',
      elements: [
        { id: 'x', type: 'text', properties: { content: 'a' } },
        {
          id: 'row',
          type: 'container',
          children: [{ id: 'x', type: 'text', properties: { content: 'b' } }],
        },
      ],
      operations: [
        {
          id: 'x',
          operationName: 'counter.add',
          inputs: [{ name: 'key', source: 'constant', sourceId: 'n' }],
          triggers: [{ type: 'event', parameters: { elementId: 'row', eventType: 'click' } }],
        },
      ],
    },
  },
  {
    name: 'unknown types degrade and intrinsics keep their tag',
    fragmentDefs: { 'basics.entry_row': ENTRY_ROW_DEF },
    shape: {
      name: 'types',
      elements: [
        { id: 'a', type: 'Widget', properties: { content: 'x' } },
        { id: 'b', type: 'DIV' },
        {
          id: 'c',
          type: 'basics.entry_row',
          properties: { label: 'What', operationId: 'op-set' },
        },
      ],
      operations: [
        {
          id: 'op-set',
          operationName: 'state.set',
          inputs: [
            { name: 'key', source: 'constant', sourceId: 'note' },
            { name: 'value', source: 'constant', sourceId: 'hi' },
          ],
        },
      ],
    },
  },
  {
    name: 'execution types resolve from names and endpoints',
    shape: {
      name: 'exec',
      elements: [
        {
          id: 'go',
          type: 'button',
          properties: { text: 'Go' },
          eventBindings: [
            { event: 'click', operationId: 'op-builtin' },
            { event: 'click', operationId: 'op-remote' },
          ],
        },
      ],
      operations: [
        {
          id: 'op-builtin',
          operationName: 'counter.add',
          inputs: [{ name: 'key', source: 'constant', sourceId: 'n' }],
          implementation: { type: 'remote', endpoint: 'https://ignored.example' },
        },
        {
          id: 'op-remote',
          operationName: 'fetch.thing',
          implementation: { type: 'remote', endpoint: 'https://api.zippopotam.us/us/90210' },
        },
      ],
    },
  },
  {
    name: 'an explicit layout survives finalization',
    shape: {
      name: 'laid-out',
      layout: { type: 'flex', properties: { flexDirection: 'row', gap: '8px' } },
      elements: [{ id: 'a', type: 'text', properties: { content: 'x' } }],
    },
  },
  {
    name: 'metadata stamps when absent and preserves what exists',
    description: 'a fallback description',
    shape: {
      name: 'stamped',
      elements: [{ id: 'a', type: 'text', properties: { content: 'x' } }],
    },
  },
  {
    name: 'provided metadata keeps its creation date and description',
    description: 'ignored fallback',
    shape: {
      name: 'kept',
      metadata: {
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
        description: 'the original description',
        version: '2.0.0',
      },
      elements: [{ id: 'a', type: 'text', properties: { content: 'x' } }],
    },
  },
];

function runComposeFinalizeCase(entry: ComposeFinalizeCase) {
  const vocab = vocabularyEcho(entry);
  const parsed = JSON.parse(JSON.stringify(LlmContractSchema.parse(entry.shape))) as ContractShape;
  const shape = jsonNormalize(parsed);
  const hadCreatedAt =
    (entry.shape.metadata as Record<string, unknown> | undefined)?.createdAt !== undefined;
  const expected = kcall('capture.finalize', {
    ...vocab,
    shape,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    nowIso: '2026-01-01T00:00:00.000Z',
  }).contract as Record<string, unknown>;
  const metadata = expected.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    metadata.updatedAt = '<stamped>';
    if (!hadCreatedAt) {
      metadata.createdAt = '<stamped>';
    }
  }
  return {
    name: entry.name,
    shape,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...vocab,
    expected,
  };
}

interface ComposeLoopCase {
  name: string;
  provider: string;
  schema: 'composed' | 'contract';
  responses: string[];
}

const COMPOSE_LOOP_CASES: ComposeLoopCase[] = [
  {
    name: 'a clean first attempt returns immediately',
    provider: 'anthropic',
    schema: 'composed',
    responses: [VALID_COMPOSED_RAW],
  },
  {
    name: 'one repair round corrects the shape',
    provider: 'anthropic',
    schema: 'composed',
    responses: [
      JSON.stringify({
        spec: { goal: 'Fixable' },
        contract: { name: 'bad', elements: [{ type: 'text' }] },
      }),
      VALID_COMPOSED_RAW,
    ],
  },
  {
    name: 'default providers stop after one repair',
    provider: 'anthropic',
    schema: 'composed',
    responses: [
      JSON.stringify({
        spec: { goal: 'Broken' },
        contract: { name: 'bad', elements: [{ type: 'text' }] },
      }),
      JSON.stringify({
        spec: { goal: 'Broken' },
        contract: { name: 'bad', elements: [{ type: 'text' }] },
      }),
    ],
  },
  {
    name: 'cheap fast providers get a second repair',
    provider: 'mercury',
    schema: 'composed',
    responses: ['Not JSON at all.', 'Still not JSON.', VALID_COMPOSED_RAW],
  },
  {
    name: 'local failures point at context truncation',
    provider: 'local',
    schema: 'composed',
    responses: ['I ran out of context.', 'Same again.', 'And again.'],
  },
];

async function runComposeLoopCase(entry: ComposeLoopCase) {
  const reply = kcall('capture.composeLoop', {
    provider: entry.provider,
    schema: entry.schema,
    responses: entry.responses,
    messages: [{ role: 'user', content: 'Build an app for this request:\n\ntest request' }],
  }) as {
    outcome: { ok: boolean; value?: unknown; error?: string };
    calls: unknown[];
  };
  const expected = reply.outcome.ok
    ? { ok: true, value: reply.outcome.value, calls: reply.calls }
    : { ok: false, error: reply.outcome.error, calls: reply.calls };
  return {
    name: entry.name,
    provider: entry.provider,
    schema: entry.schema,
    responses: entry.responses,
    expected,
  };
}

function runStreamingCase(entry: StreamingCase) {
  const partial = kcall('capture.streamingPartial', { raw: entry.raw }).partial ?? null;
  const contract = kcall('streaming.extract', { accumulated: entry.raw }).contract ?? null;
  return {
    name: entry.name,
    raw: entry.raw,
    partial: partial === null ? null : jsonNormalize(partial),
    partialRecovered: partial !== null,
    contract: contract === null ? null : jsonNormalize(contract),
  };
}

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

function runTemplateCase(entry: TemplateCase) {
  const payload = {
    instance: jsonNormalize(entry.instance),
    def: jsonNormalize(entry.def),
  };
  const expected =
    entry.kind === 'fragment'
      ? kcall('capture.templateFragment', payload).value
      : kcall('capture.templatePack', payload).value;
  return {
    name: entry.name,
    kind: entry.kind,
    def: jsonNormalize(entry.def),
    instance: jsonNormalize(entry.instance),
    expected,
  };
}

function runViewCase(entry: ViewCase) {
  const tree = kcall('capture.view', {
    elements: jsonNormalize(entry.elements),
    state: jsonNormalize(entry.state),
    fragmentDefs: jsonNormalize(entry.fragmentDefs ?? {}),
  }).tree;
  return {
    name: entry.name,
    elements: entry.elements,
    state: jsonNormalize(entry.state),
    fragmentDefs: jsonNormalize(entry.fragmentDefs ?? {}),
    expected: tree,
  };
}


/** Drives one session scenario through the headless webview runtime classes,
 * mirroring the renderer's chain rule: a failed operation stops the rest. */
async function runSessionCase(entry: SessionCase) {
  const env = {
    ids: entry.env?.ids ?? [],
    randoms: entry.env?.randoms ?? [],
    epochMs: FIXED_EPOCH_MS,
  };
  const reply = kcall('capture.session', {
    operations: jsonNormalize(entry.operations),
    initialState: jsonNormalize(entry.initialState ?? {}),
    elements: jsonNormalize(entry.elements ?? []),
    env,
    events: jsonNormalize(entry.events),
  }) as { failed: string[]; data: Record<string, unknown> };

  return {
    name: entry.name,
    operations: entry.operations,
    initialState: jsonNormalize(entry.initialState ?? {}),
    elements: entry.elements ?? [],
    env,
    events: entry.events,
    expected: { data: reply.data, failed: reply.failed },
  };
}

async function main(): Promise<void> {
  const outDir = resolve(scriptDir, '../../runtime-conformance');
  mkdirSync(outDir, { recursive: true });
  kernel = await instantiateKernel(
    readFileSync(resolve(outDir, '../runtime-wasm/dist/der_runtime_kernel.wasm'))
  );

  const transforms = TRANSFORM_CASES.map((entry) => {
    const def = TRANSFORMS[entry.transform];
    if (!def) throw new Error(`No transform ${entry.transform}`);
    const expected = kcall('capture.transform', {
      name: entry.transform,
      value: jsonNormalize(entry.input),
      parameters: jsonNormalize(entry.parameters ?? {}),
    }).value;
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
      ? kcall('capture.legacySingle', {
          value: jsonNormalize(entry.input),
          step: jsonNormalize(entry.steps[0]),
        }).value
      : kcall('capture.pipeline', {
          value: jsonNormalize(entry.input),
          steps: jsonNormalize(entry.steps),
        }).value;
    return {
      name: entry.name,
      steps: entry.steps,
      input: jsonNormalize(entry.input),
      legacySingle: entry.legacySingle ?? false,
      expected: jsonNormalize(expected),
    };
  });

  const expressions = EXPRESSION_CASES.map((entry) => {
    const parsed = kcall('capture.expressionParse', { expression: entry.expression });
    if (parsed.parseError !== undefined) {
      return { name: entry.name, expression: entry.expression, parseError: true };
    }
    const identifiers = [...(parsed.identifiers as string[])].sort();
    if (entry.row === undefined) {
      return { name: entry.name, expression: entry.expression, identifiers, parseError: false };
    }
    const evaluated = kcall('capture.expressionEval', {
      expression: entry.expression,
      row: jsonNormalize(entry.row),
    });
    if (evaluated.evalError !== undefined) {
      return {
        name: entry.name,
        expression: entry.expression,
        row: entry.row,
        identifiers,
        parseError: false,
        evalError: true,
      };
    }
    return {
      name: entry.name,
      expression: entry.expression,
      row: entry.row,
      identifiers,
      parseError: false,
      value: evaluated.value,
    };
  });

  writeFileSync(
    resolve(outDir, 'transforms.json'),
    JSON.stringify({ formatVersion: 1, transforms, pipelines }, null, 2) + '\n'
  );
  writeFileSync(
    resolve(outDir, 'expressions.json'),
    JSON.stringify({ formatVersion: 1, expressions }, null, 2) + '\n'
  );

  const operations = OPERATION_CASES.map(runOperationCase);
  writeFileSync(
    resolve(outDir, 'operations.json'),
    JSON.stringify({ formatVersion: 1, operations }, null, 2) + '\n'
  );

  const sessions = [];
  for (const entry of SESSION_CASES) {
    sessions.push(await runSessionCase(entry));
  }
  writeFileSync(
    resolve(outDir, 'sessions.json'),
    JSON.stringify({ formatVersion: 1, sessions }, null, 2) + '\n'
  );

  const templates = TEMPLATE_CASES.map(runTemplateCase);
  writeFileSync(
    resolve(outDir, 'templates.json'),
    JSON.stringify({ formatVersion: 1, templates }, null, 2) + '\n'
  );

  const views = VIEW_CASES.map(runViewCase);
  writeFileSync(
    resolve(outDir, 'views.json'),
    JSON.stringify({ formatVersion: 1, views }, null, 2) + '\n'
  );

  const streaming = STREAMING_CASES.map(runStreamingCase);
  writeFileSync(
    resolve(outDir, 'streaming.json'),
    JSON.stringify({ formatVersion: 1, streaming }, null, 2) + '\n'
  );

  const validation = VALIDATION_CASES.map(runValidationCase);
  writeFileSync(
    resolve(outDir, 'validation.json'),
    JSON.stringify({ formatVersion: 1, validation }, null, 2) + '\n'
  );

  writeFileSync(
    resolve(outDir, 'registry.json'),
    JSON.stringify(buildRegistrySnapshot(), null, 2) + '\n'
  );

  const composePrompts = COMPOSE_PROMPT_CASES.map(runComposePromptCase);
  const composeResponses = COMPOSE_RESPONSE_CASES.map(runComposeResponseCase);
  const composeFinalize = COMPOSE_FINALIZE_CASES.map(runComposeFinalizeCase);
  const composeLoop = [];
  for (const entry of COMPOSE_LOOP_CASES) {
    composeLoop.push(await runComposeLoopCase(entry));
  }
  writeFileSync(
    resolve(outDir, 'compose.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        promptSections: kcall('capture.promptSections'),
        prompts: composePrompts,
        responses: composeResponses,
        finalize: composeFinalize,
        loop: composeLoop,
      },
      null,
      2
    ) + '\n'
  );
  process.stdout.write(
    `wrote ${transforms.length} transform, ${pipelines.length} pipeline, ${expressions.length} expression, ${operations.length} operation, ${sessions.length} session, ${templates.length} template, ${views.length} view, ${streaming.length} streaming, ${validation.length} validation, ${composePrompts.length + composeResponses.length + composeFinalize.length + composeLoop.length} compose vectors\n`
  );

  // The Rust kernel is the reference: every regenerated family must pass
  // its wasm build before the corpus is considered written. A failure here
  // means the fixtures encode semantics the kernel does not implement.
  const arbiterFamilies: Array<{ family: string; file: string }> = [
    { family: 'transform', file: 'transforms.json' },
    { family: 'pipeline', file: 'transforms.json' },
    { family: 'operation', file: 'operations.json' },
    { family: 'session', file: 'sessions.json' },
    { family: 'template', file: 'templates.json' },
    { family: 'view', file: 'views.json' },
    { family: 'validation', file: 'validation.json' },
    { family: 'streaming', file: 'streaming.json' },
    { family: 'expression', file: 'expressions.json' },
    { family: 'composePrompt', file: 'compose.json' },
    { family: 'composeResponse', file: 'compose.json' },
    { family: 'composeFinalize', file: 'compose.json' },
    { family: 'composeLoop', file: 'compose.json' },
  ];
  const disagreements: string[] = [];
  for (const { family, file } of arbiterFamilies) {
    const fixtures = JSON.parse(readFileSync(resolve(outDir, file), 'utf8'));
    const outcome = kernel.run({ operation: 'vectors.runFamily', family, fixtures }) as {
      failures: string[];
    };
    for (const failure of outcome.failures) {
      disagreements.push(`${family}: ${failure}`);
    }
  }
  if (disagreements.length > 0) {
    throw new Error(
      `The Rust kernel rejects the regenerated corpus (rebuild it with scripts/build-runtime-wasm.sh if the kernel changed):\n${disagreements.join('\n')}`
    );
  }
  process.stdout.write('kernel arbiter: every family verified against the wasm build\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
