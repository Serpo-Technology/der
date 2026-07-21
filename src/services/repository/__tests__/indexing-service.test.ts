/**
 * Indexing Service Tests
 * Requirements: 6.5
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IndexingService } from '../indexing-service';
import type { ComponentManifest, UIElementManifest, OperationManifest } from '../../../types/component';
import type { RepositoryQuery } from '../../../types/repository';

describe('IndexingService', () => {
  let indexingService: IndexingService;

  const mockUIElementManifest: UIElementManifest = {
    id: 'button-1',
    name: 'Button',
    version: '1.0.0',
    type: 'ui-element',
    description: 'A clickable button component',
    capabilities: ['clickable', 'styled'],
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      }
    },
    inputs: [
      { name: 'text', type: 'string', required: true }
    ],
    outputs: [
      { name: 'onClick', type: 'event' }
    ],
    renderFunction: 'renderButton',
    styleSchema: {
      type: 'object',
      properties: {
        backgroundColor: { type: 'string' }
      }
    }
  };

  const mockOperationManifest: OperationManifest = {
    id: 'api-call-1',
    name: 'API Call',
    version: '1.0.0',
    type: 'operation',
    description: 'Makes HTTP API calls',
    capabilities: ['http', 'async'],
    dependencies: [
      { type: 'library', name: 'axios', version: '1.0.0', optional: false }
    ],
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      }
    },
    inputs: [
      { name: 'url', type: 'string', required: true }
    ],
    outputs: [
      { name: 'response', type: 'object' }
    ],
    executionType: 'remote',
    implementation: {
      type: 'remote',
      endpoint: 'https://api.example.com',
      method: 'GET'
    }
  };

  const mockTextInputManifest: UIElementManifest = {
    id: 'text-input-1',
    name: 'Text Input',
    version: '1.0.0',
    type: 'ui-element',
    description: 'A text input field',
    capabilities: ['input', 'validation'],
    dependencies: [
      { type: 'ui-element', name: 'Button', version: '1.0.0', optional: true }
    ],
    schema: {
      type: 'object',
      properties: {
        value: { type: 'string' }
      }
    },
    inputs: [
      { name: 'value', type: 'string', required: false }
    ],
    outputs: [
      { name: 'onChange', type: 'event' }
    ],
    renderFunction: 'renderTextInput',
    styleSchema: {
      type: 'object',
      properties: {
        width: { type: 'string' }
      }
    }
  };

  beforeEach(() => {
    indexingService = new IndexingService();
  });

  describe('Index Building', () => {
    it('should build index from components map', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);

      indexingService.buildIndex(components);

      const stats = indexingService.getIndexStats();
      expect(stats.totalComponents).toBe(3);
      expect(stats.totalCapabilities).toBe(6); // clickable, styled, http, async, input, validation
    });

    it('should index individual components', () => {
      indexingService.indexComponent('button-1', mockUIElementManifest);

      const stats = indexingService.getIndexStats();
      expect(stats.totalComponents).toBe(1);
      expect(stats.totalCapabilities).toBe(2); // clickable, styled
    });

    it('should remove components from index', () => {
      indexingService.indexComponent('button-1', mockUIElementManifest);
      indexingService.removeFromIndex('button-1', mockUIElementManifest);

      const stats = indexingService.getIndexStats();
      expect(stats.totalComponents).toBe(0);
      expect(stats.totalCapabilities).toBe(0);
    });
  });

  describe('Component Search', () => {
    beforeEach(() => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);
      indexingService.buildIndex(components);
    });

    it('should search by type', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);

      const query: RepositoryQuery = { type: 'ui-element' };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(2);
      expect(result.items.every(item => item.type === 'ui-element')).toBe(true);
    });

    it('should search by capabilities', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);

      const query: RepositoryQuery = { capabilities: ['clickable'] };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('button-1');
    });

    it('should search by name', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);

      const query: RepositoryQuery = { name: 'button' };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Button');
    });

    it('should search with multiple criteria', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);

      const query: RepositoryQuery = {
        type: 'ui-element',
        capabilities: ['input']
      };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('text-input-1');
    });

    it('should handle pagination', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);

      const query: RepositoryQuery = {
        limit: 2,
        offset: 0
      };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('Dependency Management', () => {
    beforeEach(() => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);
      indexingService.buildIndex(components);
    });

    it('should find dependents', () => {
      const dependents = indexingService.findDependents('Button');
      expect(dependents.has('text-input-1')).toBe(true);
    });

    it('should find all dependencies', () => {
      const dependencies = indexingService.findAllDependencies('text-input-1');
      expect(dependencies.has('Button')).toBe(true);
    });

    it('should detect circular dependencies', () => {
      // Create a circular dependency scenario
      const circularManifest: ComponentManifest = {
        ...mockUIElementManifest,
        id: 'circular-1',
        dependencies: [
          { type: 'ui-element', name: 'circular-2', version: '1.0.0', optional: false }
        ]
      };

      const circularManifest2: ComponentManifest = {
        ...mockUIElementManifest,
        id: 'circular-2',
        dependencies: [
          { type: 'ui-element', name: 'circular-1', version: '1.0.0', optional: false }
        ]
      };

      indexingService.indexComponent('circular-1', circularManifest);
      indexingService.indexComponent('circular-2', circularManifest2);

      expect(indexingService.hasCircularDependencies('circular-1')).toBe(true);
      expect(indexingService.hasCircularDependencies('circular-2')).toBe(true);
    });

    it('should not detect circular dependencies when none exist', () => {
      expect(indexingService.hasCircularDependencies('text-input-1')).toBe(false);
      expect(indexingService.hasCircularDependencies('button-1')).toBe(false);
    });
  });

  describe('Index Statistics', () => {
    it('should provide accurate statistics', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest],
        ['text-input-1', mockTextInputManifest]
      ]);
      indexingService.buildIndex(components);

      const stats = indexingService.getIndexStats();
      expect(stats.totalComponents).toBe(3);
      expect(stats.totalCapabilities).toBe(6); // clickable, styled, http, async, input, validation
      expect(stats.totalDependencies).toBe(3); // all 3 components are tracked in dependency graph
      expect(stats.lastUpdate).toBeInstanceOf(Date);
    });

    it('should update statistics when components are added', () => {
      indexingService.indexComponent('button-1', mockUIElementManifest);
      const stats1 = indexingService.getIndexStats();

      indexingService.indexComponent('api-call-1', mockOperationManifest);
      const stats2 = indexingService.getIndexStats();

      expect(stats2.totalComponents).toBe(stats1.totalComponents + 1);
      expect(stats2.lastUpdate.getTime()).toBeGreaterThanOrEqual(stats1.lastUpdate.getTime());
    });
  });

  describe('Text Tokenization', () => {
    it('should find components by partial name match', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['text-input-1', mockTextInputManifest]
      ]);
      indexingService.buildIndex(components);

      const query: RepositoryQuery = { name: 'text' };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Text Input');
    });

    it('should find components by description keywords', () => {
      const components = new Map<string, ComponentManifest>([
        ['button-1', mockUIElementManifest],
        ['api-call-1', mockOperationManifest]
      ]);
      indexingService.buildIndex(components);

      const query: RepositoryQuery = { name: 'clickable' };
      const result = indexingService.searchComponents(components, query);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].description).toContain('clickable');
    });
  });
});