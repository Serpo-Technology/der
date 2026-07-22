/**
 * Best-effort partial parsing that backs the live assembly preview. The key
 * property: any prefix of a real composed response either yields a usable
 * display contract or null, and never throws.
 */

import { describe, it, expect } from 'vitest';
import { extractStreamingContract, parsePartialJson } from '../partial-json';
import { SAMPLE_COMPOSED } from '../../../test/llm-mocks';

const FULL = JSON.stringify(SAMPLE_COMPOSED, null, 1);

describe('parsePartialJson', () => {
  it('parses a complete object as-is', () => {
    expect(parsePartialJson(FULL)).toEqual(SAMPLE_COMPOSED);
  });

  it('closes an object cut inside a string', () => {
    const parsed = parsePartialJson('{"spec": {"goal": "Create a to') as {
      spec: { goal: string };
    };
    expect(parsed.spec.goal).toBe('Create a to');
  });

  it('drops a dangling key and keeps prior members', () => {
    const parsed = parsePartialJson('{"name": "todo-list", "vers');
    expect(parsed).toEqual({ name: 'todo-list' });
  });

  it('recovers from a cut mid-number', () => {
    const parsed = parsePartialJson('{"a": 1, "b": 12') as { a: number };
    // The cut token is unusable either way; the prior member must survive.
    expect(parsed.a).toBe(1);
  });

  it('never throws on any prefix of a real response', () => {
    for (let cut = 1; cut <= FULL.length; cut += 7) {
      const parsed = parsePartialJson(FULL.slice(0, cut));
      expect(parsed === null || typeof parsed === 'object').toBe(true);
    }
  });

  it('returns null when no object has started', () => {
    expect(parsePartialJson('')).toBeNull();
    expect(parsePartialJson('Sure, here is the JSON')).toBeNull();
  });
});

describe('extractStreamingContract', () => {
  it('produces an inert display contract from a prefix', () => {
    // Cut right after the second element closes.
    const secondElementEnd = FULL.indexOf('"add-btn"');
    const raw = FULL.slice(0, FULL.indexOf('},', secondElementEnd) + 1);
    const preview = extractStreamingContract(raw)!;

    expect(preview).not.toBeNull();
    expect(preview.name).toBe('todo-list');
    expect(preview.operations).toEqual([]);
    expect(preview.elements.length).toBeGreaterThanOrEqual(2);
    for (const element of preview.elements) {
      expect(element.eventBindings).toEqual([]);
    }
  });

  it('keeps nested children and data bindings with known transforms only', () => {
    const raw = JSON.stringify({
      contract: {
        name: 'x',
        elements: [
          {
            id: 'row',
            type: 'container',
            children: [
              {
                id: 'total',
                type: 'text',
                dataBindings: [
                  {
                    property: 'content',
                    source: 'state',
                    sourceId: 'items',
                    transforms: [
                      { type: 'count', parameters: {} },
                      { type: 'sparkle', parameters: {} }
                    ]
                  }
                ],
                eventBindings: [{ event: 'click', operationId: 'op-x' }]
              }
            ]
          }
        ]
      }
    });
    const preview = extractStreamingContract(raw)!;

    const total = preview.elements[0].children![0];
    expect(total.dataBindings[0].transforms).toEqual([{ type: 'count', parameters: {} }]);
    expect(total.eventBindings).toEqual([]);
  });

  it('passes styling through for early theming', () => {
    const raw = JSON.stringify({
      contract: {
        name: 'x',
        styling: { theme: 'dark', accent: 'green' },
        elements: [{ id: 'a', type: 'text', properties: { content: 'hi' } }]
      }
    });
    expect(extractStreamingContract(raw)!.styling).toEqual({ theme: 'dark', accent: 'green' });
  });

  it('returns null before any element is complete', () => {
    expect(extractStreamingContract('{"spec": {"goal": "x"}, "contract": {"name": "y"')).toBeNull();
  });
});
