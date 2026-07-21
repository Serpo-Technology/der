import { describe, it, expect } from 'vitest';
import type { Blueprint } from '../blueprint';

describe('Blueprint Types', () => {
  it('should create a valid Blueprint object', () => {
    const blueprint: Blueprint = {
      description: 'Test blueprint',
      goal: 'Test goal',
      requiredCapabilities: ['test'],
      uiElements: [],
      operations: [],
      ambiguities: []
    };

    expect(blueprint.description).toBe('Test blueprint');
    expect(blueprint.goal).toBe('Test goal');
    expect(blueprint.requiredCapabilities).toEqual(['test']);
    expect(blueprint.uiElements).toEqual([]);
    expect(blueprint.operations).toEqual([]);
    expect(blueprint.ambiguities).toEqual([]);
  });
});