/**
 * Tests for the shared transform registry. Covers each transform's null
 * safety and type coercion, binding application (the legacy singular
 * transform versus a pipeline), pipeline ordering, and unknown transform
 * handling.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TRANSFORMS, applyBindingTransforms, applyTransformPipeline } from '../transforms';

const apply = (name: string, value: unknown, parameters: Record<string, any> = {}) =>
  TRANSFORMS[name].apply(value, parameters);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TRANSFORMS', () => {
  describe('count', () => {
    it('filterTruthy and filterFalsy split rows by flag, counting missing as falsy', () => {
    const rows = [
      { id: 'a', completed: true },
      { id: 'b', completed: false },
      { id: 'c' }
    ];
    const truthy = TRANSFORMS.filterTruthy.apply(rows, { field: 'completed' });
    const falsy = TRANSFORMS.filterFalsy.apply(rows, { field: 'completed' });
    expect((truthy as Array<{ id: string }>).map((r) => r.id)).toEqual(['a']);
    expect((falsy as Array<{ id: string }>).map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('counts array entries and returns 0 for anything else', () => {
      expect(apply('count', [1, 2, 3])).toBe(3);
      expect(apply('count', [])).toBe(0);
      expect(apply('count', undefined)).toBe(0);
      expect(apply('count', 'nope')).toBe(0);
      expect(apply('count', { length: 5 })).toBe(0);
    });
  });

  describe('sum', () => {
    it('sums a field and coerces missing or non-numeric values to 0', () => {
      const rows = [{ amount: 2 }, { amount: '3.5' }, {}, { amount: 'oops' }];

      expect(apply('sum', rows, { field: 'amount' })).toBe(5.5);
    });

    it('returns 0 for non-arrays', () => {
      expect(apply('sum', undefined, { field: 'amount' })).toBe(0);
    });
  });

  describe('filterBy', () => {
    it('keeps entries whose field loosely equals the value', () => {
      const rows = [
        { id: 1, completed: false },
        { id: 2, completed: true },
      ];

      expect(apply('filterBy', rows, { field: 'completed', value: 'false' })).toEqual([
        { id: 1, completed: false },
      ]);
    });

    it('returns an empty array for non-arrays', () => {
      expect(apply('filterBy', 'nope', { field: 'completed', value: 'false' })).toEqual([]);
      expect(apply('filterBy', undefined, { field: 'completed', value: 'false' })).toEqual([]);
    });
  });

  describe('sortBy', () => {
    it('sorts numerically when both values are numbers and returns a new array', () => {
      const original = [{ v: 10 }, { v: 2 }, { v: 1 }];

      const sorted = apply('sortBy', original, { field: 'v' });

      // Lexicographic ordering would give 1, 10, 2.
      expect(sorted).toEqual([{ v: 1 }, { v: 2 }, { v: 10 }]);
      expect(sorted).not.toBe(original);
      expect(original).toEqual([{ v: 10 }, { v: 2 }, { v: 1 }]);
    });

    it('falls back to locale ordering for non-numeric values', () => {
      const rows = [{ name: 'cherry' }, { name: 'apple' }, { name: 'banana' }];

      expect(apply('sortBy', rows, { field: 'name' })).toEqual([
        { name: 'apple' },
        { name: 'banana' },
        { name: 'cherry' },
      ]);
    });

    it('reverses the order with direction desc', () => {
      const rows = [{ v: 2 }, { v: 10 }, { v: 5 }];

      expect(apply('sortBy', rows, { field: 'v', direction: 'desc' })).toEqual([
        { v: 10 },
        { v: 5 },
        { v: 2 },
      ]);
    });
  });

  describe('pick', () => {
    it('reads a field through a dot path', () => {
      expect(apply('pick', { user: { name: 'Ada' } }, { field: 'user.name' })).toBe('Ada');
      expect(apply('pick', { user: {} }, { field: 'user.name' })).toBeUndefined();
    });
  });

  describe('equals and not', () => {
    it('compares loosely across the string boundary', () => {
      expect(apply('equals', 5, { value: '5' })).toBe(true);
      expect(apply('equals', 'a', { value: 'b' })).toBe(false);
    });

    it('negates truthiness', () => {
      expect(apply('not', true)).toBe(false);
      expect(apply('not', '')).toBe(true);
      expect(apply('not', 0)).toBe(true);
    });
  });

  describe('parseNumber', () => {
    it('parses numeric text and falls back to 0', () => {
      expect(apply('parseNumber', '12.5')).toBe(12.5);
      expect(apply('parseNumber', 'abc')).toBe(0);
    });
  });

  describe('round', () => {
    it('returns a fixed string when decimals is greater than 0', () => {
      expect(apply('round', 3.14159, { decimals: 2 })).toBe('3.14');
    });

    it('returns a number when decimals is 0', () => {
      expect(apply('round', 3.6, { decimals: 0 })).toBe(4);
      expect(apply('round', 2.4)).toBe(2);
    });

    it('passes non-numeric values through unchanged', () => {
      expect(apply('round', 'abc', { decimals: 2 })).toBe('abc');
    });
  });

  describe('format', () => {
    it('coerces numbers into the template', () => {
      expect(apply('format', 0, { template: '{{value}}' })).toBe('0');
      expect(apply('format', 3, { template: '{{value}} items left' })).toBe('3 items left');
    });

    it('returns the value unchanged without a string template', () => {
      expect(apply('format', 'raw', {})).toBe('raw');
    });
  });

  describe('map', () => {
    it('replaces the value through the lookup table', () => {
      expect(apply('map', 'a', { mapping: { a: 'Alpha' } })).toBe('Alpha');
    });

    it('falls back to the original value on a missing key', () => {
      expect(apply('map', 'z', { mapping: { a: 'Alpha' } })).toBe('z');
      expect(apply('map', 'z', {})).toBe('z');
    });
  });
});

describe('applyBindingTransforms', () => {
  it('returns the value untouched when the binding has no transforms', () => {
    expect(applyBindingTransforms('plain', {})).toBe('plain');
  });

  it('skips the legacy singular transform on null and undefined', () => {
    const binding = { transform: { type: 'count', parameters: {} } };

    expect(applyBindingTransforms(undefined, binding)).toBeUndefined();
    expect(applyBindingTransforms(null, binding)).toBeNull();
  });

  it('applies the legacy singular transform to present values', () => {
    const binding = { transform: { type: 'format', parameters: { template: 'Hello {{value}}' } } };

    expect(applyBindingTransforms('world', binding)).toBe('Hello world');
  });

  it('runs a transforms pipeline even on undefined', () => {
    const binding = { transforms: [{ type: 'count', parameters: {} }] };

    expect(applyBindingTransforms(undefined, binding)).toBe(0);
  });

  it('runs pipeline steps in order', () => {
    const todos = [
      { id: 1, completed: false },
      { id: 2, completed: true },
    ];
    const filterThenCount = {
      transforms: [
        { type: 'filterBy', parameters: { field: 'completed', value: 'false' } },
        { type: 'count', parameters: {} },
      ],
    };
    const countThenFilter = {
      transforms: [
        { type: 'count', parameters: {} },
        { type: 'filterBy', parameters: { field: 'completed', value: 'false' } },
      ],
    };

    expect(applyBindingTransforms(todos, filterThenCount)).toBe(1);
    // Counting first leaves a number, so the later filterBy sees a non-array.
    expect(applyBindingTransforms(todos, countThenFilter)).toEqual([]);
  });

  it('prefers the pipeline over the legacy singular transform', () => {
    const binding = {
      transforms: [{ type: 'count', parameters: {} }],
      transform: { type: 'format', parameters: { template: '{{value}} items' } },
    };

    expect(applyBindingTransforms(['a', 'b'], binding)).toBe(2);
  });
});

describe('applyTransformPipeline', () => {
  it('returns the value unchanged for a missing or empty pipeline', () => {
    expect(applyTransformPipeline(5, undefined)).toBe(5);
    expect(applyTransformPipeline(5, [])).toBe(5);
  });

  it('skips unknown transform types with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = applyTransformPipeline('keep', [{ type: 'sparkle', parameters: {} }]);

    expect(result).toBe('keep');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sparkle'));
  });

  it('continues the pipeline after a skipped unknown step', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = applyTransformPipeline(
      [1, 2],
      [
        { type: 'sparkle', parameters: {} },
        { type: 'count', parameters: {} },
      ]
    );

    expect(result).toBe(2);
  });
});

describe('pluck', () => {
  it('projects a field across an array of objects', () => {
    const result = TRANSFORMS.pluck.apply(
      [{ value: 5 }, { value: 7 }, { other: 1 }],
      { field: 'value' }
    );
    expect(result).toEqual([5, 7, undefined]);
  });

  it('is null-safe and returns [] for non-arrays', () => {
    expect(TRANSFORMS.pluck.apply(undefined, { field: 'value' })).toEqual([]);
    expect(TRANSFORMS.pluck.apply({ value: 5 }, { field: 'value' })).toEqual([]);
  });

  it('feeds numeric pipelines from object lists', () => {
    const result = applyBindingTransforms([{ value: 2 }, { value: 4 }], {
      transforms: [
        { type: 'pluck', parameters: { field: 'value' } },
        { type: 'sum', parameters: {} }
      ]
    });
    expect(result).toBe(6);
  });
});

describe('dynamic parameters and filterContains', () => {
  it('filterContains matches case-insensitively and empty text keeps all', () => {
    const rows = [{ t: 'Buy milk' }, { t: 'Call mom' }, { t: 'milking time' }];
    const hit = TRANSFORMS.filterContains.apply(rows, { field: 't', value: 'MILK' });
    expect((hit as unknown[]).length).toBe(2);
    expect(TRANSFORMS.filterContains.apply(rows, { field: 't', value: '' })).toEqual(rows);
  });

  it('resolves dynamic parameter references through the context lookup', () => {
    const rows = [{ cat: 'a' }, { cat: 'b' }];
    const out = applyBindingTransforms(
      rows,
      {
        transforms: [
          {
            type: 'filterBy',
            parameters: { field: 'cat', value: { source: 'element', sourceId: 'cat-in' } }
          }
        ]
      },
      {
        lookup: (source, sourceId) =>
          source === 'element' && sourceId === 'cat-in' ? 'b' : undefined
      }
    );
    expect(out).toEqual([{ cat: 'b' }]);
  });

  it('treats references as undefined when no lookup is provided', () => {
    const rows = [{ cat: 'a' }];
    const out = applyBindingTransforms(rows, {
      transforms: [
        { type: 'filterBy', parameters: { field: 'cat', value: { source: 'state', sourceId: 'x' } } }
      ]
    });
    expect(out).toEqual([]);
  });
});

describe('formatDate', () => {
  it('formats ISO strings and epochs, passes junk through, blanks null', () => {
    const iso = '2026-07-23T15:30:00Z';
    expect(String(TRANSFORMS.formatDate.apply(iso, { style: 'date' }))).toContain('2026');
    expect(String(TRANSFORMS.formatDate.apply(1784800000000, { style: 'date' }))).toContain('202');
    expect(TRANSFORMS.formatDate.apply('not a date', { style: 'date' })).toBe('not a date');
    expect(TRANSFORMS.formatDate.apply(null, { style: 'date' })).toBe('');
    expect(String(TRANSFORMS.formatDate.apply(iso, { style: 'weekday' })).length).toBeGreaterThan(3);
  });
});

describe('formatNumber', () => {
  it('groups thousands with fixed decimals and affixes', () => {
    const out = String(
      TRANSFORMS.formatNumber.apply(1234567.891, { decimals: 2, prefix: '$ ', suffix: '' })
    );
    expect(out.startsWith('$ ')).toBe(true);
    expect(out).toContain('567');
    expect(out.endsWith('89')).toBe(true);
    expect(TRANSFORMS.formatNumber.apply('junk', { decimals: 2 })).toBe('junk');
  });
});
