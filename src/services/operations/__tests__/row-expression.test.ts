/**
 * The row expression parser mirrors the expr compute part's grammar: same
 * operators, functions, constants, and error behavior, evaluated over a
 * row's fields.
 */

import { describe, it, expect } from 'vitest';
import { parseRowExpression } from '../row-expression';

describe('parseRowExpression', () => {
  it('computes arithmetic with precedence, parentheses, and power', () => {
    const row = { qty: 4, price: 2.5 };
    expect(parseRowExpression('qty * price').evaluate(row)).toBe(10);
    expect(parseRowExpression('1 + qty * 2').evaluate(row)).toBe(9);
    expect(parseRowExpression('(1 + qty) * 2').evaluate(row)).toBe(10);
    expect(parseRowExpression('2 ^ qty').evaluate(row)).toBe(16);
    expect(parseRowExpression('-qty + 5').evaluate(row)).toBe(1);
    expect(parseRowExpression('9 % qty').evaluate(row)).toBe(1);
  });

  it('supports the part functions and constants', () => {
    const row = { x: 9, y: -3 };
    expect(parseRowExpression('sqrt(x)').evaluate(row)).toBe(3);
    expect(parseRowExpression('abs(y)').evaluate(row)).toBe(3);
    expect(parseRowExpression('min(x, 5)').evaluate(row)).toBe(5);
    expect(parseRowExpression('max(x, 5)').evaluate(row)).toBe(9);
    expect(parseRowExpression('pow(y, 2)').evaluate(row)).toBe(9);
    expect(parseRowExpression('round(pi)').evaluate({})).toBe(3);
    expect(parseRowExpression('floor(e)').evaluate({})).toBe(2);
  });

  it('lists the row fields it reads, excluding functions and constants', () => {
    const parsed = parseRowExpression('round(Qty * price + pi)');
    expect(parsed.identifiers.sort()).toEqual(['price', 'qty']);
  });

  it('matches row fields case-insensitively and parses numeric strings', () => {
    expect(parseRowExpression('qty * price').evaluate({ Qty: '4', PRICE: '1.5' })).toBe(6);
  });

  it('throws for missing or non-numeric fields and division by zero', () => {
    expect(() => parseRowExpression('qty * price').evaluate({ qty: 2 })).toThrow(/price/);
    expect(() => parseRowExpression('qty').evaluate({ qty: 'many' })).toThrow(/numeric/);
    expect(() => parseRowExpression('1 / n').evaluate({ n: 0 })).toThrow(/division/);
    expect(() => parseRowExpression('sqrt(n)').evaluate({ n: -1 })).toThrow(/negative/);
  });

  it('rejects syntax errors, unknown functions, and wrong arities at parse time', () => {
    expect(() => parseRowExpression('qty *')).toThrow();
    expect(() => parseRowExpression('(qty')).toThrow(/parenthesis/);
    expect(() => parseRowExpression('hack(qty)')).toThrow(/unknown function/);
    expect(() => parseRowExpression('min(1)')).toThrow(/two arguments/);
    expect(() => parseRowExpression('sqrt(1, 2)')).toThrow(/one argument/);
    expect(() => parseRowExpression('')).toThrow(/empty/);
    expect(() => parseRowExpression('qty; alert(1)')).toThrow();
  });
});
