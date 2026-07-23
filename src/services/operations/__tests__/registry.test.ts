/**
 * Tests for the builtin part registry. Covers structured input assembly, the
 * generic state and list operations against a minimal state context, loose
 * equality across the string boundary, the http.get bridge through the Tauri
 * command, and the catalog invariants (examples parse against the contract
 * schemas, compat todos parts stay hidden).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BUILTIN_OPERATIONS,
  ELEMENT_MANIFESTS,
  OperationContext,
  assembleStructured,
  getValueAtPath,
  looseEquals,
} from '../registry';
import { OperationBindingSchema, UIElementSchema } from '../../../schemas/contract';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function makeCtx(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const ctx: OperationContext = {
    getState: vi.fn((key: string) => store[key]),
    setState: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
  };
  return { store, ctx };
}

async function run(name: string, inputs: Record<string, unknown>, ctx: OperationContext) {
  return await BUILTIN_OPERATIONS[name].execute(inputs, ctx);
}

describe('registry helpers', () => {
  describe('assembleStructured', () => {
    it('groups prefixed inputs into objects and leaves the rest flat', () => {
      const assembled = assembleStructured(
        { key: 'todos', 'item.title': 'Buy milk', 'item.amount': 3 },
        ['item']
      );

      expect(assembled).toEqual({
        key: 'todos',
        item: { title: 'Buy milk', amount: 3 },
      });
    });

    it('returns the input unchanged when no prefixes are declared', () => {
      const raw = { key: 'todos', 'item.title': 'x' };

      expect(assembleStructured(raw, undefined)).toBe(raw);
      expect(assembleStructured(raw, [])).toBe(raw);
    });
  });

  describe('looseEquals', () => {
    it('matches values across the string boundary', () => {
      expect(looseEquals(1, '1')).toBe(true);
      expect(looseEquals(false, 'false')).toBe(true);
      expect(looseEquals('a', 'a')).toBe(true);
      expect(looseEquals('a', 'b')).toBe(false);
    });
  });

  describe('getValueAtPath', () => {
    it('resolves dot paths and returns the value itself for an empty path', () => {
      const value = { user: { name: 'Ada' } };

      expect(getValueAtPath(value, 'user.name')).toBe('Ada');
      expect(getValueAtPath(value, '')).toBe(value);
      expect(getValueAtPath(value, 'user.missing.deep')).toBeUndefined();
    });
  });
});

describe('builtin operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('state.set', () => {
    it('writes arbitrary values including boolean false', async () => {
      const { store, ctx } = makeCtx({ flag: true });

      const result = await run('state.set', { key: 'flag', value: false }, ctx);

      expect(result).toEqual({ value: false });
      expect(store.flag).toBe(false);
      expect(ctx.setState).toHaveBeenCalledWith('flag', false);
    });

    it('stores object values as they are', async () => {
      const { store, ctx } = makeCtx();
      const payload = { view: 'done', count: 2 };

      const result = await run('state.set', { key: 'settings', value: payload }, ctx);

      expect(result.value).toBe(payload);
      expect(store.settings).toBe(payload);
    });
  });

  describe('counter.add', () => {
    it('adds 1 when no amount is given', async () => {
      const { store, ctx } = makeCtx({ clicks: 2 });

      const result = await run('counter.add', { key: 'clicks' }, ctx);

      expect(result).toEqual({ value: 3 });
      expect(store.clicks).toBe(3);
    });

    it('coerces string amounts and starts missing keys at zero', async () => {
      const { store, ctx } = makeCtx();

      const result = await run('counter.add', { key: 'clicks', amount: '5' }, ctx);

      expect(result).toEqual({ value: 5 });
      expect(store.clicks).toBe(5);
    });

    it('treats a non-numeric amount as zero', async () => {
      const { store, ctx } = makeCtx({ clicks: 2 });

      const result = await run('counter.add', { key: 'clicks', amount: 'abc' }, ctx);

      expect(result).toEqual({ value: 2 });
      expect(store.clicks).toBe(2);
    });

    it('subtracts with a negative amount', async () => {
      const { store, ctx } = makeCtx({ clicks: 5 });

      await run('counter.add', { key: 'clicks', amount: -2 }, ctx);

      expect(store.clicks).toBe(3);
    });
  });

  describe('list.append', () => {
    it('appends an item with a generated id and returns the reset marker', async () => {
      const { store, ctx } = makeCtx({ items: [] });

      const result = await run(
        'list.append',
        { key: 'items', item: { title: 'Milk', amount: 3 } },
        ctx
      );

      const item = result.item as Record<string, unknown>;
      expect(item.title).toBe('Milk');
      expect(item.amount).toBe(3);
      expect(typeof item.id).toBe('string');
      expect((item.id as string).length).toBeGreaterThan(0);
      expect(result.list).toEqual([item]);
      expect(result.reset).toBe('');
      expect(store.items).toEqual([item]);
    });

    it('overwrites a provided item id with a generated one', async () => {
      const { ctx } = makeCtx({ items: [] });

      const result = await run(
        'list.append',
        { key: 'items', item: { id: 'mine', title: 'Milk' } },
        ctx
      );

      const item = result.item as Record<string, unknown>;
      expect(item.id).not.toBe('mine');
      expect(typeof item.id).toBe('string');
    });

    it('skips without writing state when every field is blank', async () => {
      const existing = [{ id: 'e1', title: 'Keep me' }];
      const { store, ctx } = makeCtx({ items: existing });

      const result = await run(
        'list.append',
        { key: 'items', item: { title: '   ', note: null } },
        ctx
      );

      expect(result).toEqual({ list: existing, item: null, reset: '' });
      expect(ctx.setState).not.toHaveBeenCalled();
      expect(store.items).toBe(existing);
    });

    it('treats an item carrying only an id as empty', async () => {
      const { ctx } = makeCtx({ items: [] });

      const result = await run('list.append', { key: 'items', item: { id: 'x' } }, ctx);

      expect(result.item).toBeNull();
      expect(ctx.setState).not.toHaveBeenCalled();
    });

    it('starts a fresh list when the state key is missing', async () => {
      const { store, ctx } = makeCtx();

      const result = await run('list.append', { key: 'items', item: { title: 'First' } }, ctx);

      expect(result.list).toHaveLength(1);
      expect(store.items).toEqual(result.list);
    });
  });

  describe('list.removeWhere', () => {
    it('removes items matching on the default id field across the string boundary', async () => {
      const { store, ctx } = makeCtx({ items: [{ id: 1 }, { id: 2 }] });

      const result = await run('list.removeWhere', { key: 'items', value: '1' }, ctx);

      expect(result.list).toEqual([{ id: 2 }]);
      expect(store.items).toEqual([{ id: 2 }]);
    });

    it('matches on a custom field when given', async () => {
      const { store, ctx } = makeCtx({
        items: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'open' },
        ],
      });

      await run('list.removeWhere', { key: 'items', field: 'status', value: 'done' }, ctx);

      expect(store.items).toEqual([{ id: 'b', status: 'open' }]);
    });
  });

  describe('list.updateWhere', () => {
    it('merges set fields into matching items and counts the matches', async () => {
      const { store, ctx } = makeCtx({
        items: [
          { id: 1, title: 'First', done: false },
          { id: 2, title: 'Second', done: false },
        ],
      });

      const result = await run(
        'list.updateWhere',
        { key: 'items', value: '1', set: { title: 'Renamed', done: true } },
        ctx
      );

      expect(result.count).toBe(1);
      expect(result.list).toEqual([
        { id: 1, title: 'Renamed', done: true },
        { id: 2, title: 'Second', done: false },
      ]);
      expect(store.items).toEqual(result.list);
    });

    it('reports zero matches without changing any item', async () => {
      const items = [{ id: 1, title: 'First' }];
      const { ctx } = makeCtx({ items });

      const result = await run(
        'list.updateWhere',
        { key: 'items', value: '99', set: { title: 'Nope' } },
        ctx
      );

      expect(result.count).toBe(0);
      expect(result.list).toEqual(items);
    });

    it('matches on a custom field when given', async () => {
      const { store, ctx } = makeCtx({
        items: [
          { id: 1, status: 'open' },
          { id: 2, status: 'open' },
        ],
      });

      const result = await run(
        'list.updateWhere',
        { key: 'items', field: 'status', value: 'open', set: { status: 'closed' } },
        ctx
      );

      expect(result.count).toBe(2);
      expect(store.items).toEqual([
        { id: 1, status: 'closed' },
        { id: 2, status: 'closed' },
      ]);
    });
  });

  describe('list.toggleField', () => {
    it('flips the default completed field on the matching item', async () => {
      const { store, ctx } = makeCtx({
        items: [
          { id: 1, completed: false },
          { id: 2, completed: false },
        ],
      });

      const result = await run('list.toggleField', { key: 'items', id: '2' }, ctx);

      expect(result.list).toEqual([
        { id: 1, completed: false },
        { id: 2, completed: true },
      ]);
      expect(store.items).toEqual(result.list);
    });

    it('flips a custom boolean field when given', async () => {
      const { store, ctx } = makeCtx({ items: [{ id: 't1', archived: true }] });

      await run('list.toggleField', { key: 'items', id: 't1', field: 'archived' }, ctx);

      expect(store.items).toEqual([{ id: 't1', archived: false }]);
    });
  });

  describe('http.get', () => {
    it('rejects urls that are not http(s)', async () => {
      const { ctx } = makeCtx();

      await expect(run('http.get', { url: 'file:///etc/hosts' }, ctx)).rejects.toThrow(
        'http.get needs an http(s) URL'
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('routes the fetch through the execute_operation command', async () => {
      mockInvoke.mockResolvedValue({ success: true, data: { items: [1, 2] } });
      const { ctx } = makeCtx();

      const result = await run('http.get', { url: 'https://example.com/data.json' }, ctx);

      expect(result).toEqual({ response: { items: [1, 2] } });
      expect(mockInvoke).toHaveBeenCalledWith('execute_operation', {
        request: expect.objectContaining({
          operation_type: 'remote',
          implementation: expect.objectContaining({
            endpoint: 'https://example.com/data.json',
            method: 'GET',
          }),
        }),
      });
    });

    it('throws the backend error when the command reports failure', async () => {
      mockInvoke.mockResolvedValue({ success: false, error: 'boom' });
      const { ctx } = makeCtx();

      await expect(run('http.get', { url: 'https://example.com/x' }, ctx)).rejects.toThrow('boom');
    });
  });
});

describe('catalog invariants', () => {
  it('parses every visible builtin example with OperationBindingSchema', () => {
    let checked = 0;
    for (const def of Object.values(BUILTIN_OPERATIONS)) {
      if (def.hidden || !def.example) continue;
      checked++;
      const result = OperationBindingSchema.safeParse(def.example);
      expect(result.success, `example for ${def.name} should parse`).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('parses every element manifest example with UIElementSchema', () => {
    let checked = 0;
    for (const manifest of Object.values(ELEMENT_MANIFESTS)) {
      if (!manifest.example) continue;
      checked++;
      const result = UIElementSchema.safeParse(manifest.example);
      expect(result.success, `example for ${manifest.type} should parse`).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps the compat todos parts hidden from the catalog', () => {
    for (const name of ['todos.add', 'todos.toggle', 'todos.remove']) {
      expect(BUILTIN_OPERATIONS[name]?.hidden, `${name} should be hidden`).toBe(true);
    }
  });
});

describe('time.now', () => {
  it('returns iso, sortable date, time, and epoch', async () => {
    const def = BUILTIN_OPERATIONS['time.now'];
    const out = (await def.execute({}, {
      getState: () => undefined,
      setState: () => undefined
    } as never)) as Record<string, unknown>;
    expect(String(out.iso)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(out.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(out.time)).toMatch(/^\d{2}:\d{2}$/);
    expect(typeof out.epoch).toBe('number');
  });
});
