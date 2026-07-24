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
import { BUILTIN_OPERATIONS, assembleStructured } from '../../src/services/operations/registry';
import { ExperienceStateManager } from '../../src/components/runtime/ExperienceStateManager';
import { OperationExecutor } from '../../src/components/runtime/OperationExecutor';
import type { Contract, OperationBinding } from '../../src/types/contract';

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
  { name: 'state.set writes and echoes', operation: 'state.set', inputs: { key: 'view', value: 'done' }, state: {} },
  { name: 'state.set typed value', operation: 'state.set', inputs: { key: 'running', value: true }, state: { running: false } },
  { name: 'state.set missing value stores null', operation: 'state.set', inputs: { key: 'x' }, state: {} },

  { name: 'counter.add default amount', operation: 'counter.add', inputs: { key: 'clicks' }, state: { clicks: 2 } },
  { name: 'counter.add unseeded key', operation: 'counter.add', inputs: { key: 'clicks' }, state: {} },
  { name: 'counter.add negative amount', operation: 'counter.add', inputs: { key: 'n', amount: -2 }, state: { n: 5 } },
  { name: 'counter.add junk amount is zero', operation: 'counter.add', inputs: { key: 'n', amount: 'x' }, state: { n: 5 } },
  { name: 'counter.add string state coerces', operation: 'counter.add', inputs: { key: 'n' }, state: { n: '41' } },

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
    state: { cards: [{ id: 'c1', column: 'todo' }, { id: 'c2', column: 'todo' }] },
  },
  {
    name: 'list.updateWhere matches loosely on a custom field',
    operation: 'list.updateWhere',
    inputs: { key: 'rows', field: 'qty', value: '4', 'set.flag': true },
    state: { rows: [{ id: 'a', qty: 4 }, { id: 'b', qty: 10 }] },
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

  { name: 'math.add coerces junk to zero', operation: 'math.add', inputs: { a: '2.5', b: 'x' }, state: {} },

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
  { name: 'random.int junk bounds error', operation: 'random.int', inputs: { min: 'x', max: 6 }, state: {} },

  {
    name: 'random.pick chooses by roll',
    operation: 'random.pick',
    inputs: { list: ['a', 'b', 'c'] },
    state: {},
    env: { randoms: [0.7] },
  },
  { name: 'random.pick empty list errors', operation: 'random.pick', inputs: { list: [] }, state: {} },

  {
    name: 'todos.add trims and stamps',
    operation: 'todos.add',
    inputs: { title: '  buy milk  ' },
    state: TODO_STATE,
    env: { ids: ['t3'] },
  },
  { name: 'todos.add blank skips', operation: 'todos.add', inputs: { title: '   ' }, state: TODO_STATE },
  { name: 'todos.toggle flips by id', operation: 'todos.toggle', inputs: { id: 't2' }, state: TODO_STATE },
  { name: 'todos.remove drops by id', operation: 'todos.remove', inputs: { id: 't1' }, state: TODO_STATE },
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
    initialState: { rows: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }] },
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
        outputs: [
          { name: 'value', target: 'ui-element', targetId: 'status', property: 'text' },
        ],
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

  const state: Record<string, unknown> = JSON.parse(JSON.stringify(entry.state));
  const ctx = {
    getState: (key: string) => state[key],
    setState: (key: string, value: unknown) => {
      state[key] = value;
    },
  };

  const idQueue = [...(entry.env?.ids ?? [])];
  const randomQueue = [...(entry.env?.randoms ?? [])];
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string };
  const originalUuid = cryptoObject.randomUUID?.bind(cryptoObject);
  const originalRandom = Math.random;
  const OriginalDate = globalThis.Date;
  cryptoObject.randomUUID = () => {
    const next = idQueue.shift();
    if (next === undefined) throw new Error(`${entry.name}: ran out of scripted ids`);
    return next;
  };
  Math.random = () => {
    const next = randomQueue.shift();
    if (next === undefined) throw new Error(`${entry.name}: ran out of scripted randoms`);
    return next;
  };
  class FixedDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(FIXED_EPOCH_MS);
      } else {
        super(...(args as [number]));
      }
    }
    static now() {
      return FIXED_EPOCH_MS;
    }
  }
  (globalThis as { Date: unknown }).Date = FixedDate;

  try {
    // The executor assembles dotted prefixes before execute runs; the Rust
    // kernel assembles inside execute_builtin, so the vectors carry the flat
    // inputs and the assembly is covered on both sides.
    const assembled = assembleStructured(entry.inputs, def.structuredPrefixes);
    const outputs = def.execute(assembled as never, ctx) as Record<string, unknown>;
    if (outputs instanceof Promise) throw new Error(`${entry.name}: async builtins stay outside the kernel`);
    const frozenOutputs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(outputs)) {
      if (!entry.shapeOnlyOutputs?.includes(name)) {
        frozenOutputs[name] = jsonNormalize(value);
      }
    }
    return {
      name: entry.name,
      operation: entry.operation,
      inputs: jsonNormalize(entry.inputs),
      state: jsonNormalize(entry.state),
      env: { ids: entry.env?.ids ?? [], randoms: entry.env?.randoms ?? [], epochMs: FIXED_EPOCH_MS },
      shapeOnlyOutputs: entry.shapeOnlyOutputs ?? [],
      error: false,
      expected: { state: jsonNormalize(state), outputs: frozenOutputs },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(entry.name)) throw error;
    return {
      name: entry.name,
      operation: entry.operation,
      inputs: jsonNormalize(entry.inputs),
      state: jsonNormalize(entry.state),
      env: { ids: entry.env?.ids ?? [], randoms: entry.env?.randoms ?? [], epochMs: FIXED_EPOCH_MS },
      shapeOnlyOutputs: [],
      error: true,
      expected: { state: jsonNormalize(entry.state), outputs: {} },
    };
  } finally {
    if (originalUuid) cryptoObject.randomUUID = originalUuid;
    Math.random = originalRandom;
    (globalThis as { Date: unknown }).Date = OriginalDate;
  }
}


/** Scripts ids, randomness, and the clock for the duration of one case. */
async function withScriptedGlobals<T>(
  env: { ids?: string[]; randoms?: number[] } | undefined,
  run: () => Promise<T>
): Promise<T> {
  const idQueue = [...(env?.ids ?? [])];
  const randomQueue = [...(env?.randoms ?? [])];
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string };
  const originalUuid = cryptoObject.randomUUID?.bind(cryptoObject);
  const originalRandom = Math.random;
  const OriginalDate = globalThis.Date;
  cryptoObject.randomUUID = () => {
    const next = idQueue.shift();
    if (next === undefined) throw new Error('ran out of scripted ids');
    return next;
  };
  Math.random = () => {
    const next = randomQueue.shift();
    if (next === undefined) throw new Error('ran out of scripted randoms');
    return next;
  };
  class FixedDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(FIXED_EPOCH_MS);
      } else {
        super(...(args as [number]));
      }
    }
    static now() {
      return FIXED_EPOCH_MS;
    }
  }
  (globalThis as { Date: unknown }).Date = FixedDate;
  try {
    return await run();
  } finally {
    if (originalUuid) cryptoObject.randomUUID = originalUuid;
    Math.random = originalRandom;
    (globalThis as { Date: unknown }).Date = OriginalDate;
  }
}

/** Drives one session scenario through the headless webview runtime classes,
 * mirroring the renderer's chain rule: a failed operation stops the rest. */
async function runSessionCase(entry: SessionCase) {
  return await withScriptedGlobals(entry.env, async () => {
    const manager = new ExperienceStateManager('vector');
    await manager.initializeState({
      initialState: entry.initialState,
      operations: entry.operations as unknown as OperationBinding[],
      elements: entry.elements ?? [],
    } as unknown as Contract);
    const executor = new OperationExecutor();
    const failed: string[] = [];

    for (const event of entry.events) {
      if (event.do === 'setElement') {
        manager.setData(`element_${event.elementId}`, event.value);
        continue;
      }
      for (const operationId of event.operationIds) {
        const operation = entry.operations.find((op) => op.id === operationId);
        if (!operation) throw new Error(`${entry.name}: no operation ${operationId}`);
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

    return {
      name: entry.name,
      operations: entry.operations,
      initialState: jsonNormalize(entry.initialState ?? {}),
      elements: entry.elements ?? [],
      env: { ids: entry.env?.ids ?? [], randoms: entry.env?.randoms ?? [], epochMs: FIXED_EPOCH_MS },
      events: entry.events,
      expected: { data: jsonNormalize(manager.getState().data), failed },
    };
  });
}

async function main(): Promise<void> {
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
  process.stdout.write(
    `wrote ${transforms.length} transform, ${pipelines.length} pipeline, ${expressions.length} expression, ${operations.length} operation, ${sessions.length} session vectors\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
