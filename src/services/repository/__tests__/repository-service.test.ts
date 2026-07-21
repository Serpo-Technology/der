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

interface StorageOptions {
  /** JSON string returned for read_repository_index; missing means no stored index. */
  indexJson?: string;
  /** JSON string returned for read_component_manifest. */
  manifestJson?: string;
  /** Reject every write/delete command with a storage error. */
  failWrites?: boolean;
}

/**
 * Routes invoke calls by command name. Each test primes storage before
 * constructing a service, so initialization is deterministic and no
 * queued one-shot mocks leak between tests.
 */
function primeStorage(options: StorageOptions = {}): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'read_repository_index':
        if (options.indexJson === undefined) {
          throw new Error('No index found');
        }
        return options.indexJson;
      case 'read_component_manifest':
        if (options.manifestJson === undefined) {
          throw new Error('No manifest found');
        }
        return options.manifestJson;
      case 'write_repository_index':
      case 'write_component_manifest':
      case 'delete_component_manifest':
        if (options.failWrites) {
          throw new Error('Storage error');
        }
        return undefined;
      default:
        return undefined;
    }
  });
}

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

  const fullIndexJson = () => JSON.stringify({
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
  });

  beforeEach(() => {
    // Start each test from empty storage; index writes succeed.
    primeStorage();
    repositoryService = new RepositoryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Component Registration', () => {
    it('should register a UI element component', async () => {
      await repositoryService.registerComponent(mockUIElementManifest);

      expect(mockInvoke).toHaveBeenCalledWith('write_component_manifest', {
        path: 'repository/components/button-1-1.0.0.json',
        data: JSON.stringify(mockUIElementManifest, null, 2)
      });
    });

    it('should register an operation component', async () => {
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
      primeStorage({ indexJson: fullIndexJson() });

      const testService = new RepositoryService();
      const component = await testService.getComponent('button-1');
      expect(component).toEqual(mockUIElementManifest);
    });

    it('should return null for non-existent component', async () => {
      primeStorage({ indexJson: fullIndexJson() });

      const testService = new RepositoryService();
      const component = await testService.getComponent('non-existent');
      expect(component).toBeNull();
    });

    it('should get component by ID and version', async () => {
      const olderManifest = { ...mockUIElementManifest, version: '0.9.0' };
      primeStorage({
        indexJson: fullIndexJson(),
        manifestJson: JSON.stringify(olderManifest)
      });

      const testService = new RepositoryService();
      // The indexed version is 1.0.0; requesting another version reads storage.
      const component = await testService.getComponent('button-1', '0.9.0');
      expect(component).toEqual(olderManifest);
      expect(mockInvoke).toHaveBeenCalledWith('read_component_manifest', {
        path: 'repository/components/button-1-0.9.0.json'
      });
    });
  });

  describe('Component Querying', () => {
    let testService: RepositoryService;

    beforeEach(() => {
      primeStorage({ indexJson: fullIndexJson() });
      testService = new RepositoryService();
    });

    it('should query UI elements', async () => {
      const uiElements = await testService.queryUIElements({});
      expect(uiElements).toHaveLength(1);
      expect(uiElements[0]).toEqual(mockUIElementManifest);
    });

    it('should query operations', async () => {
      const operations = await testService.queryOperations({});
      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual(mockOperationManifest);
    });

    it('should filter by capabilities', async () => {
      const clickableComponents = await testService.queryUIElements({
        capabilities: ['clickable']
      });
      expect(clickableComponents).toHaveLength(1);
      expect(clickableComponents[0].id).toBe('button-1');

      const unmatched = await testService.queryUIElements({
        capabilities: ['nonexistent']
      });
      expect(unmatched).toHaveLength(0);
    });

    it('should filter by name', async () => {
      const buttonComponents = await testService.queryUIElements({
        name: 'Button'
      });
      expect(buttonComponents).toHaveLength(1);
      expect(buttonComponents[0].name).toBe('Button');
    });
  });

  describe('Component Management', () => {
    let testService: RepositoryService;

    beforeEach(() => {
      primeStorage({ indexJson: fullIndexJson() });
      testService = new RepositoryService();
    });

    it('should update existing component', async () => {
      const updatedManifest = {
        ...mockUIElementManifest,
        description: 'Updated button component'
      };

      await testService.updateComponent('button-1', updatedManifest);

      expect(mockInvoke).toHaveBeenCalledWith('write_component_manifest', {
        path: 'repository/components/button-1-1.0.0.json',
        data: JSON.stringify(updatedManifest, null, 2)
      });
      const component = await testService.getComponent('button-1');
      expect(component?.description).toBe('Updated button component');
    });

    it('should delete component', async () => {
      await testService.deleteComponent('button-1');

      expect(mockInvoke).toHaveBeenCalledWith('delete_component_manifest', {
        path: 'repository/components/button-1-*.json'
      });
      const component = await testService.getComponent('button-1');
      expect(component).toBeNull();
    });

    it('should list all components', async () => {
      const allComponents = await testService.listComponents();
      expect(allComponents).toHaveLength(2);
      expect(allComponents).toContainEqual(mockUIElementManifest);
      expect(allComponents).toContainEqual(mockOperationManifest);
    });

    it('should list components by type', async () => {
      const uiElements = await testService.listComponents('ui-element');
      expect(uiElements).toHaveLength(1);
      expect(uiElements[0].type).toBe('ui-element');
    });
  });

  describe('Error Handling', () => {
    it('should keep components in memory when storage writes fail', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      primeStorage({ failWrites: true });
      const testService = new RepositoryService();

      // Registration succeeds even though the manifest and index writes fail.
      await expect(testService.registerComponent(mockUIElementManifest))
        .resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('registered in memory only'),
        expect.anything()
      );

      // The in-memory index still serves the component.
      const uiElements = await testService.queryUIElements({});
      expect(uiElements).toHaveLength(1);
      expect(uiElements[0]).toEqual(mockUIElementManifest);
    });

    it('should recover from invalid JSON in index', async () => {
      primeStorage({ indexJson: 'this is not valid json {{{' });

      // The service falls back to a fresh empty index instead of failing.
      const freshService = new RepositoryService();
      await expect(freshService.getComponent('test')).resolves.toBeNull();
      await expect(freshService.listComponents()).resolves.toEqual([]);
    });
  });
});
