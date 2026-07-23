/**
 * Safe arithmetic over a row's fields, evaluated synchronously so transform
 * pipelines can derive per-row values. The grammar matches the expr compute
 * part exactly: + - * / % ^, parentheses, unary minus, one-argument
 * sqrt/abs/floor/ceil/round, two-argument min/max/pow, and the constants pi
 * and e. This is configuration, never code: only the listed operators and
 * functions exist, identifiers resolve to row fields, and there is no way to
 * call into anything else.
 */

const MAX_EXPRESSION_CHARS = 4096;
const MAX_DEPTH = 64;

const ONE_ARG_FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: (x) => {
    if (x < 0) throw new Error('sqrt of a negative number');
    return Math.sqrt(x);
  },
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const TWO_ARG_FUNCTIONS: Record<string, (a: number, b: number) => number> = {
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'constant'; value: number }
  | { kind: 'unary'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '%' | '^'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

export interface ParsedExpression {
  /** Row fields the expression reads (lowercased; functions and constants excluded). */
  identifiers: string[];
  /** Computes the value for one row; throws when a referenced field is
   * missing or not numeric, or on division by zero. */
  evaluate(row: Record<string, unknown>): number;
}

class Parser {
  private pos = 0;
  private depth = 0;
  readonly identifiers = new Set<string>();

  constructor(private readonly source: string) {}

  parse(): Node {
    const node = this.expr();
    this.skipWs();
    if (this.pos < this.source.length) {
      throw new Error(`unexpected character '${this.source[this.pos]}'`);
    }
    return node;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new Error('expression is too deeply nested');
  }

  private leave(): void {
    this.depth -= 1;
  }

  private peek(): string | undefined {
    return this.source[this.pos];
  }

  private skipWs(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) this.pos += 1;
  }

  private expr(): Node {
    let node = this.term();
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '+' || ch === '-') {
        this.pos += 1;
        node = { kind: 'binary', op: ch, left: node, right: this.term() };
      } else {
        return node;
      }
    }
  }

  private term(): Node {
    let node = this.power();
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '*' || ch === '/' || ch === '%') {
        this.pos += 1;
        node = { kind: 'binary', op: ch, left: node, right: this.power() };
      } else {
        return node;
      }
    }
  }

  private power(): Node {
    this.enter();
    const base = this.unary();
    this.skipWs();
    let node = base;
    if (this.peek() === '^') {
      this.pos += 1;
      node = { kind: 'binary', op: '^', left: base, right: this.power() };
    }
    this.leave();
    return node;
  }

  private unary(): Node {
    this.enter();
    this.skipWs();
    let node: Node;
    if (this.peek() === '-') {
      this.pos += 1;
      node = { kind: 'unary', operand: this.unary() };
    } else {
      node = this.primary();
    }
    this.leave();
    return node;
  }

  private primary(): Node {
    this.skipWs();
    const ch = this.peek();
    if (ch === '(') {
      this.pos += 1;
      const node = this.expr();
      this.skipWs();
      if (this.peek() !== ')') throw new Error('missing closing parenthesis');
      this.pos += 1;
      return node;
    }
    if (ch !== undefined && (/[0-9]/.test(ch) || ch === '.')) return this.number();
    if (ch !== undefined && /[a-zA-Z]/.test(ch)) return this.identifier();
    if (ch === undefined) throw new Error('unexpected end of expression');
    throw new Error(`unexpected character '${ch}'`);
  }

  private number(): Node {
    const start = this.pos;
    let seenDot = false;
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if (/[0-9]/.test(ch)) {
        this.pos += 1;
      } else if (ch === '.' && !seenDot) {
        seenDot = true;
        this.pos += 1;
      } else {
        break;
      }
    }
    const text = this.source.slice(start, this.pos);
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`invalid number '${text}'`);
    return { kind: 'number', value };
  }

  private identifier(): Node {
    const start = this.pos;
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.source[this.pos])) {
      this.pos += 1;
    }
    const name = this.source.slice(start, this.pos).toLowerCase();
    this.skipWs();
    if (this.peek() === '(') {
      this.pos += 1;
      const args: Node[] = [this.expr()];
      for (;;) {
        this.skipWs();
        const ch = this.peek();
        if (ch === ',') {
          this.pos += 1;
          args.push(this.expr());
        } else if (ch === ')') {
          this.pos += 1;
          break;
        } else {
          throw new Error(`unterminated call to ${name}`);
        }
      }
      if (name in ONE_ARG_FUNCTIONS) {
        if (args.length !== 1) throw new Error(`${name} takes one argument`);
      } else if (name in TWO_ARG_FUNCTIONS) {
        if (args.length !== 2) throw new Error(`${name} takes two arguments`);
      } else {
        throw new Error(`unknown function '${name}'`);
      }
      return { kind: 'call', name, args };
    }
    if (name in CONSTANTS) return { kind: 'constant', value: CONSTANTS[name] };
    this.identifiers.add(name);
    return { kind: 'ident', name };
  }
}

function numericField(row: Record<string, unknown>, name: string): number {
  // Field names match case-insensitively, like the expr part's variables.
  let raw = row[name];
  if (raw === undefined) {
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name);
    raw = key === undefined ? undefined : row[key];
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`row has no numeric "${name}"`);
}

function evaluateNode(node: Node, row: Record<string, unknown>): number {
  switch (node.kind) {
    case 'number':
    case 'constant':
      return node.value;
    case 'ident':
      return numericField(row, node.name);
    case 'unary':
      return -evaluateNode(node.operand, row);
    case 'call': {
      const args = node.args.map((arg) => evaluateNode(arg, row));
      return node.name in ONE_ARG_FUNCTIONS
        ? ONE_ARG_FUNCTIONS[node.name](args[0])
        : TWO_ARG_FUNCTIONS[node.name](args[0], args[1]);
    }
    case 'binary': {
      const left = evaluateNode(node.left, row);
      const right = evaluateNode(node.right, row);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          if (right === 0) throw new Error('division by zero');
          return left / right;
        case '%':
          if (right === 0) throw new Error('division by zero');
          return left % right;
        case '^':
          return Math.pow(left, right);
      }
    }
  }
}

const parseCache = new Map<string, ParsedExpression>();

/** Parses an expression once; throws on syntax errors, unknown functions,
 * and wrong argument counts. Results are cached by source string. */
export function parseRowExpression(source: string): ParsedExpression {
  const cached = parseCache.get(source);
  if (cached) return cached;
  if (source.length > MAX_EXPRESSION_CHARS) throw new Error('expression is too long');
  if (source.trim() === '') throw new Error('expression is empty');
  const parser = new Parser(source);
  const root = parser.parse();
  const parsed: ParsedExpression = {
    identifiers: [...parser.identifiers],
    evaluate: (row) => evaluateNode(root, row),
  };
  if (parseCache.size > 200) parseCache.clear();
  parseCache.set(source, parsed);
  return parsed;
}
