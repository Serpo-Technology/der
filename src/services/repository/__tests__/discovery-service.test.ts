/**
 * Discovery Service Tests
 * Requirements: 6.3, 6.4, 7.3, 7.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiscoveryService } from '../discovery-service';
import type { UIElementManifest, OperationManifest } from '../../../types/component';

// Mock repository service
vi.mock('../repository-service', () => ({
  repositoryService: {
    searchComponents: vi.fn(),
    queryUIElements: vi.fn(),
    queryOperations: vi.fn(),
    listComponents: vi.fn(),
    getComponent: vi.fn()
  }
}));

import { repositoryService } from '../repository-service';

const mockRepositoryService = vi.mocked(repositoryService);

describe('DiscoveryService', () => {
  let discoveryService: DiscoveryService;

  const mockUIElement: UIElementManifest = {
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
        color: { type: 'string' }
      }
    }
  };

  const mockOperation: OperationManifest = {
    id: 'api-1',
    name: 'API Call',
    version: '1.0.0',
    type: 'operation',
    description: 'Makes HTTP API calls',
    capabilities: ['http', 'async'],
    dependencies: [],
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

  const mockTextInput: UIElementManifest = {
    id: 'text-input-1',
    name: 'Text Input',
    version: '1.0.0',
    type: 'ui-element',
    description: 'A text input field for user data entry',
    capabilities: ['input', 'validation'],
    dependencies: [],
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
    discoveryService = new DiscoveryService();
    vi.clearAllMocks();
  });

  describe('Component Discovery', () => {
    it('should discover components with basic query', async () => {
      const mockResults = {
        items: [mockUIElement, mockOperation],
        total: 2,
        hasMore: false
      };

      mockRepositoryService.searchComponents.mockResolvedValue(mockResults);

      const results = await discoveryService.discoverComponents({
        type: 'ui-element',
        capabilities: ['clickable']
      });

      expect(results.items).toHaveLength(2);
      expect(results.query.type).toBe('ui-element');
      expect(results.facets).toBeDefined();
    });

    it('should sort results by relevance', async () => {
      const mockResults = {
        items: [mockUIElement, mockTextInput],
        total: 2,
        hasMore: false
      };

      mockRepositoryService.searchComponents.mockResolvedValue(mockResults);

      const results = await discoveryService.discoverComponents({
        capabilities: ['clickable'],
        sortBy: 'relevance'
      });

      // Button should come first as it has the clickable capability
      expect(results.items[0].id).toBe('button-1');
    });

    it('should generate facets for filtering', async () => {
      const mockResults = {
        items: [mockUIElement, mockOperation, mockTextInput],
        total: 3,
        hasMore: false
      };

      mockRepositoryService.searchComponents.mockResolvedValue(mockResults);

      const results = await discoveryService.discoverComponents({});

      expect(results.facets).toBeDefined();
      expect(results.facets?.capabilities).toHaveProperty('clickable', 1);
      expect(results.facets?.capabilities).toHaveProperty('http', 1);
      expect(results.facets?.types).toHaveProperty('ui-element', 2);
      expect(results.facets?.types).toHaveProperty('operation', 1);
    });
  });

  describe('Capability-based Discovery', () => {
    it('should find components by capability requirements', async () => {
      mockRepositoryService.listComponents.mockResolvedValue([
        mockUIElement,
        mockOperation,
        mockTextInput
      ]);

      const recommendations = await discoveryService.findByCapabilityRequirements(
        ['clickable'], // required
        ['styled'], // optional
        ['http'] // excluded
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].component.id).toBe('button-1');
      expect(recommendations[0].compatibility).toBe('full');
      expect(recommendations[0].score).toBeGreaterThan(0);
    });

    it('should score components correctly', async () => {
      mockRepositoryService.listComponents.mockResolvedValue([
        mockUIElement,
        mockTextInput
      ]);

      const recommendations = await discoveryService.findByCapabilityRequirements(
        ['input'], // required - only text input has this
        ['validation'] // optional - text input has this too
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].component.id).toBe('text-input-1');
      expect(recommendations[0].score).toBeGreaterThan(100); // Should have high score
    });
  });

  describe('Compatible Component Sets', () => {
    it('should find compatible component sets', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockUIElement);
      mockRepositoryService.queryUIElements.mockImplementation((criteria) => {
        if (criteria.capabilities?.includes('input')) {
          return Promise.resolve([mockTextInput]);
        }
        return Promise.resolve([]);
      });
      mockRepositoryService.queryOperations.mockImplementation((criteria) => {
        if (criteria.capabilities?.includes('http')) {
          return Promise.resolve([mockOperation]);
        }
        return Promise.resolve([]);
      });

      const result = await discoveryService.findCompatibleSets(
        'button-1',
        ['input', 'http']
      );

      expect(result.sets).toHaveLength(1);
      expect(result.sets[0]).toContain(mockUIElement); // Base component
      expect(result.coverage).toHaveProperty('input');
      expect(result.coverage).toHaveProperty('http');
    });
  });

  describe('Component Recommendations', () => {
    it('should get recommendations based on context', async () => {
      mockRepositoryService.getComponent.mockImplementation((id) => {
        if (id === 'button-1') return Promise.resolve(mockUIElement);
        return Promise.resolve(null);
      });

      mockRepositoryService.listComponents.mockResolvedValue([
        mockTextInput,
        mockOperation
      ]);

      const recommendations = await discoveryService.getRecommendations(['button-1']);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].score).toBeGreaterThan(0);
      expect(recommendations[0].reasons).toBeDefined();
    });

    it('should filter out context components from recommendations', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockUIElement);
      mockRepositoryService.listComponents.mockResolvedValue([
        mockUIElement, // This should be filtered out
        mockTextInput,
        mockOperation
      ]);

      const recommendations = await discoveryService.getRecommendations(['button-1']);

      const recommendedIds = recommendations.map(r => r.component.id);
      expect(recommendedIds).not.toContain('button-1');
    });
  });

  describe('Semantic Search', () => {
    it('should search components by semantic similarity', async () => {
      mockRepositoryService.listComponents.mockResolvedValue([
        mockUIElement,
        mockTextInput,
        mockOperation
      ]);

      const results = await discoveryService.searchSemantic('button click');

      expect(results.length).toBeGreaterThan(0);
      // Button should be first as it matches "button" and has "clickable" capability
      expect(results[0].id).toBe('button-1');
    });

    it('should filter by type in semantic search', async () => {
      mockRepositoryService.listComponents.mockResolvedValue([mockUIElement]);

      const results = await discoveryService.searchSemantic('button', 'ui-element');

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('ui-element');
    });
  });

  describe('Similar Component Finding', () => {
    it('should find similar components', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockUIElement);
      mockRepositoryService.listComponents.mockResolvedValue([
        mockUIElement,
        mockTextInput, // Different type of UI element
        mockOperation // Different type entirely
      ]);

      const similar = await discoveryService.findSimilar('button-1', 0.1);

      // Should find text input as it's also a UI element
      expect(similar.length).toBeGreaterThan(0);
      expect(similar.every(c => c.type === 'ui-element')).toBe(true);
      expect(similar.every(c => c.id !== 'button-1')).toBe(true);
    });

    it('should respect similarity threshold', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockUIElement);
      mockRepositoryService.listComponents.mockResolvedValue([
        mockUIElement,
        mockOperation // Very different component
      ]);

      const similar = await discoveryService.findSimilar('button-1', 0.8);

      // With high threshold, should find fewer or no similar components
      expect(similar.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing example component', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);

      await expect(discoveryService.findSimilar('non-existent'))
        .rejects.toThrow('Example component non-existent not found');
    });

    it('should handle empty component lists gracefully', async () => {
      mockRepositoryService.listComponents.mockResolvedValue([]);

      const recommendations = await discoveryService.findByCapabilityRequirements(['clickable']);

      expect(recommendations).toHaveLength(0);
    });
  });
});