/**
 * Repository Service Tests
 * Requirements: 6.1, 6.2, 6.5
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RepositoryService } from '../repository-service';
import type { ComponentManifest, UIElementManifest, OperationManifest } from '../../../types/component';
import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('RepositoryService', () => {
  let repositoryService: RepositoryService;

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
        text: { type: 'string' },
        onClick: { type: 'function' }
      }
    },
    inputs: [
      { name: 'text', type: 'string', required: true },
      { name: 'disabled', type: 'boolean', required: false }
    ],
    outputs: [
      { name: 'onClick', type: 'event' }
    ],
    renderFunction: 'renderButton',
    styleSchema: {
      type: 'object',
      properties: {
        backgroundColor: { type: 'string' },
        color: { type: 'string' }
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
    dependencies: [],
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' }
      }
    },
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: 'string', required: false }
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

  beforeEach(() => {
    mockInvoke.mockClear();
    // Mock empty index by default
    mockInvoke.mockRejectedValue(new Error('No index found'));
    repositoryService = new RepositoryService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Component Registration', () => {
    it('should register a UI element component', async () => {
      mockInvoke.mockResolvedValueOnce('{}'); // loadIndex
      mockInvoke.mockResolvedValueOnce(undefined); // writeComponentManifest
      mockInvoke.mockResolvedValueOnce(undefined); // writeRepositoryIndex

      await repositoryService.registerComponent(mockUIElementManifest);

      expect(mockInvoke).toHaveBeenCalledWith('write_component_manifest', {
        path: 'repository/components/button-1-1.0.0.json',
        data: JSON.stringify(mockUIElementManifest, null, 2)
      });
    });

    it('should register an operation component', async () => {
      mockInvoke.mockResolvedValueOnce('{}'); // loadIndex
      mockInvoke.mockResolvedValueOnce(undefined); // writeComponentManifest
      mockInvoke.mockResolvedValueOnce(undefined); // writeRepositoryIndex

      await repositoryService.registerComponent(mockOperationManifest);

      expect(mockInvoke).toHaveBeenCalledWith('write_component_manifest', {
        path: 'repository/components/api-call-1-1.0.0.json',
        data: JSON.stringify(mockOperationManifest, null, 2)
      });
    });

    it('should validate manifest before registration', async () => {
      const invalidManifest = {
        ...mockUIElementManifest,
        id: '', // Invalid empty ID
      };

      await expect(repositoryService.registerComponent(invalidManifest as ComponentManifest))
        .rejects.toThrow('Component manifest missing required fields');
    });

    it('should validate component type', async () => {
      const invalidManifest = {
        ...mockUIElementManifest,
        type: 'invalid-type' as 'ui-element' | 'operation',
      };

      await expect(repositoryService.registerComponent(invalidManifest))
        .rejects.toThrow('Invalid component type');
    });
  });

  describe('Component Retrieval', () => {
    it('should get component by ID', async () => {
      // Mock successful index loading with components
      const mockIndexData = {
        components: {
          'button-1': mockUIElementManifest,
          'api-call-1': mockOperationManifest
        },
        capabilities: {
          'clickable': ['button-1'],
          'http': ['api-call-1']
        },
        dependencies: {},
        lastUpdated: new Date().toISOString()
      };
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValue(JSON.stringify(mockIndexData));
      
      const testService = new RepositoryService();
      const component = await testService.getComponent('button-1');
      expect(component).toEqual(mockUIElementManifest);
    });

    it('should return null for non-existent component', async () => {
      const mockIndexData = {
        components: {
          'button-1': mockUIElementManifest
        },
        capabilities: {},
        dependencies: {},
        lastUpdated: new Date().toISOString()
      };
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValue(JSON.stringify(mockIndexData));
      
      const testService = new RepositoryService();
      const component = await testService.getComponent('non-existent');
      expect(component).toBeNull();
    });

    it('should get component by ID and version', async () => {
      const mockIndexData = {
        components: {
          'button-1': mockUIElementManifest
        },
        capabilities: {},
        dependencies: {},
        lastUpdated: new Date().toISOString()
      };
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValue(JSON.stringify(mockIndexData));
      mockInvoke.mockResolvedValueOnce(JSON.stringify(mockUIElementManifest)); // read_component_manifest
      
      const testService = new RepositoryService();
      const component = await testService.getComponent('button-1', '1.0.0');
      expect(component).toEqual(mockUIElementManifest);
    });
  });

  describe('Component Querying', () => {
    it('should query UI elements', async () => {
      // Mock successful index loading with components
      const mockIndexData = {
        components: {
          'button-1': mockUIElementManifest,
          'api-call-1': mockOperationManifest
        },
        capabilities: {
          'clickable': ['button-1'],
          'styled': ['button-1'],
          'http': ['api-call-1'],
          'async': ['api-call-1']
        },
        dependencies: {},
        lastUpdated: new Date().toISOString()
      };
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValue(JSON.stringify(mockIndexData));
      
      const testService = new RepositoryService();
      const uiElements = await testService.queryUIElements({});
      expect(uiElements).toHaveLength(1);
      expect(uiElements[0]).toEqual(mockUIElementManifest);
    });

    it('should query operations', async () => {
      const operations = await repositoryService.queryOperations({});
      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual(mockOperationManifest);
    });

    it('should filter by capabilities', async () => {
      const clickableComponents = await repositoryService.queryUIElements({
        capabilities: ['clickable']
      });
      expect(clickableComponents).toHaveLength(1);
      expect(clickableComponents[0].id).toBe('button-1');
    });

    it('should filter by name', async () => {
      const buttonComponents = await repositoryService.queryUIElements({
        name: 'Button'
      });
      expect(buttonComponents).toHaveLength(1);
      expect(buttonComponents[0].name).toBe('Button');
    });
  });

  describe('Component Management', () => {
    beforeEach(() => {
      // Mock successful index loading
      const mockIndexData = {
        components: {
          'button-1': mockUIElementManifest
        },
        capabilities: {
          'clickable': ['button-1'],
          'styled': ['button-1']
        },
        dependencies: {},
        lastUpdated: new Date().toISOString()
      };
      mockInvoke.mockResolvedValue(JSON.stringify(mockIndexData));
    });

    it('should update existing component', async () => {
      const updatedManifest = {
        ...mockUIElementManifest,
        description: 'Updated button component'
      };

      mockInvoke.mockResolvedValueOnce(undefined); // writeComponentManifest
      mockInvoke.mockResolvedValueOnce(undefined); // writeRepositoryIndex

      await repositoryService.updateComponent('button-1', updatedManifest);

      expect(mockInvoke).toHaveBeenCalledWith('write_component_manifest', {
        path: 'repository/components/button-1-1.0.0.json',
        data: JSON.stringify(updatedManifest, null, 2)
      });
    });

    it('should delete component', async () => {
      mockInvoke.mockResolvedValueOnce(undefined); // deleteComponentManifest
      mockInvoke.mockResolvedValueOnce(undefined); // writeRepositoryIndex

      await repositoryService.deleteComponent('button-1');

      expect(mockInvoke).toHaveBeenCalledWith('delete_component_manifest', {
        path: 'repository/components/button-1-*.json'
      });
    });

    it('should list all components', async () => {
      const allComponents = await repositoryService.listComponents();
      expect(allComponents).toHaveLength(1);
      expect(allComponents[0]).toEqual(mockUIElementManifest);
    });

    it('should list components by type', async () => {
      const uiElements = await repositoryService.listComponents('ui-element');
      expect(uiElements).toHaveLength(1);
      expect(uiElements[0].type).toBe('ui-element');
    });
  });

  describe('Error Handling', () => {
    it('should handle storage errors gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Storage error'));

      await expect(repositoryService.registerComponent(mockUIElementManifest))
        .rejects.toThrow('Failed to register component');
    });

    it('should handle invalid JSON in index', async () => {
      mockInvoke.mockClear();
      mockInvoke.mockRejectedValue(new Error('Invalid JSON'));

      const freshService = new RepositoryService();
      await expect(freshService.getComponent('test'))
        .rejects.toThrow();
    });
  });
});