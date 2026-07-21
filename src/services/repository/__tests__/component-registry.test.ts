/**
 * Component Registry Tests
 * Requirements: 6.3, 6.4, 7.3, 7.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentRegistry } from '../component-registry';
import type { UIElementManifest, OperationManifest } from '../../../types/component';

// Mock repository service
vi.mock('../repository-service', () => ({
  repositoryService: {
    getComponent: vi.fn(),
    registerComponent: vi.fn(),
    deleteComponent: vi.fn(),
    queryUIElements: vi.fn(),
    queryOperations: vi.fn(),
    listComponents: vi.fn(),
    findDependents: vi.fn(),
    findAllDependencies: vi.fn(),
    searchComponents: vi.fn()
  }
}));

// Mock indexing service
vi.mock('../indexing-service', () => ({
  indexingService: {
    hasCircularDependencies: vi.fn()
  }
}));

import { repositoryService } from '../repository-service';
import { indexingService } from '../indexing-service';

const mockRepositoryService = vi.mocked(repositoryService);
const mockIndexingService = vi.mocked(indexingService);

describe('ComponentRegistry', () => {
  let registry: ComponentRegistry;

  const mockUIElement: UIElementManifest = {
    id: 'test-button',
    name: 'Test Button',
    version: '1.0.0',
    type: 'ui-element',
    description: 'A test button component',
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
    id: 'test-api',
    name: 'Test API',
    version: '1.0.0',
    type: 'operation',
    description: 'A test API operation',
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

  beforeEach(() => {
    registry = new ComponentRegistry();
    vi.clearAllMocks();
  });

  describe('Component Registration', () => {
    it('should register a UI element component', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);
      mockRepositoryService.registerComponent.mockResolvedValue();

      await registry.registerUIElement(mockUIElement);

      expect(mockRepositoryService.registerComponent).toHaveBeenCalledWith(mockUIElement);
    });

    it('should register an operation component', async () => {
      mockRepositoryService.getComponent.mockImplementation((id) => {
        if (id === 'test-api') return Promise.resolve(null);
        if (id === 'axios') return Promise.resolve({
          id: 'axios',
          name: 'Axios',
          version: '1.0.0',
          type: 'operation' as const,
          description: 'HTTP client',
          capabilities: ['http'],
          dependencies: [],
          schema: { type: 'object' },
          inputs: [],
          outputs: [],
          executionType: 'local' as const,
          implementation: { type: 'local' as const }
        });
        return Promise.resolve(null);
      });
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);
      mockRepositoryService.registerComponent.mockResolvedValue();

      await registry.registerOperation(mockOperation);

      expect(mockRepositoryService.registerComponent).toHaveBeenCalledWith(mockOperation);
    });

    it('should prevent duplicate registration without allowOverwrite', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockUIElement);

      await expect(registry.registerUIElement(mockUIElement))
        .rejects.toThrow('Component test-button already exists');
    });

    it('should allow overwrite when specified', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockUIElement);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);
      mockRepositoryService.registerComponent.mockResolvedValue();

      await registry.registerUIElement(mockUIElement, { allowOverwrite: true });

      expect(mockRepositoryService.registerComponent).toHaveBeenCalledWith(mockUIElement);
    });

    it('should validate component manifest', async () => {
      const invalidComponent = {
        ...mockUIElement,
        id: '' // Invalid empty ID
      };

      mockRepositoryService.getComponent.mockResolvedValue(null);

      await expect(registry.registerUIElement(invalidComponent as UIElementManifest))
        .rejects.toThrow('Component manifest missing required fields');
    });

    it('should detect circular dependencies', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(true);

      await expect(registry.registerUIElement(mockUIElement))
        .rejects.toThrow('Circular dependencies detected');
    });
  });

  describe('Component Discovery', () => {
    it('should find components by capabilities', async () => {
      mockRepositoryService.queryUIElements.mockResolvedValue([mockUIElement]);
      mockRepositoryService.queryOperations.mockResolvedValue([]);

      const results = await registry.findByCapabilities(['clickable']);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(mockUIElement);
    });

    it('should find components by type and capabilities', async () => {
      mockRepositoryService.queryUIElements.mockResolvedValue([mockUIElement]);

      const results = await registry.findByTypeAndCapabilities('ui-element', ['clickable']);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(mockUIElement);
    });

    it('should suggest compatible components', async () => {
      mockRepositoryService.listComponents.mockResolvedValue([mockUIElement, mockOperation]);

      const suggestions = await registry.suggestComponents(['clickable'], []);

      expect(suggestions.exact).toHaveLength(1);
      expect(suggestions.exact[0]).toEqual(mockUIElement);
    });
  });

  describe('Dependency Management', () => {
    it('should resolve component dependencies', async () => {
      const axiosComponent = {
        id: 'axios',
        name: 'Axios',
        version: '1.0.0',
        type: 'operation' as const,
        description: 'HTTP client',
        capabilities: ['http'],
        dependencies: [],
        schema: { type: 'object' },
        inputs: [],
        outputs: [],
        executionType: 'local' as const,
        implementation: { type: 'local' as const }
      };

      mockRepositoryService.getComponent.mockResolvedValue(axiosComponent);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);

      const resolution = await registry.resolveDependencies(mockOperation);

      expect(resolution.resolved).toHaveLength(1);
      expect(resolution.missing).toHaveLength(0);
      expect(resolution.circular).toHaveLength(0);
    });

    it('should detect missing dependencies', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);

      const resolution = await registry.resolveDependencies(mockOperation);

      expect(resolution.resolved).toHaveLength(0);
      expect(resolution.missing).toHaveLength(1);
      expect(resolution.missing[0].name).toBe('axios');
    });

    it('should get dependency tree', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(mockOperation);
      mockRepositoryService.findDependents.mockResolvedValue([]);
      mockRepositoryService.findAllDependencies.mockResolvedValue([]);

      const tree = await registry.getDependencyTree('test-api');

      expect(tree.component).toEqual(mockOperation);
      expect(tree.dependencies).toBeDefined();
      expect(tree.dependents).toBeDefined();
      expect(tree.allDependencies).toBeDefined();
    });

    it('should validate dependencies', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);

      const validation = await registry.validateDependencies(mockOperation);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Required dependency not found: axios@1.0.0');
    });
  });

  describe('Component Unregistration', () => {
    it('should unregister component without dependents', async () => {
      mockRepositoryService.findDependents.mockResolvedValue([]);
      mockRepositoryService.deleteComponent.mockResolvedValue();

      await registry.unregisterComponent('test-button');

      expect(mockRepositoryService.deleteComponent).toHaveBeenCalledWith('test-button');
    });

    it('should prevent unregistration of components with dependents', async () => {
      mockRepositoryService.findDependents.mockResolvedValue([mockOperation]);

      await expect(registry.unregisterComponent('test-button'))
        .rejects.toThrow('Cannot remove component test-button. It is used by: test-api');
    });
  });

  describe('Registration Tracking', () => {
    it('should track component registrations', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);
      mockRepositoryService.registerComponent.mockResolvedValue();

      await registry.registerUIElement(mockUIElement, { source: 'custom' });

      const registration = registry.getRegistrationInfo('test-button');
      expect(registration).toBeDefined();
      expect(registration?.source).toBe('custom');
      expect(registration?.manifest).toEqual(mockUIElement);
    });

    it('should list registrations by source', async () => {
      mockRepositoryService.getComponent.mockResolvedValue(null);
      mockIndexingService.hasCircularDependencies.mockResolvedValue(false);
      mockRepositoryService.registerComponent.mockResolvedValue();

      await registry.registerUIElement(mockUIElement, { source: 'custom' });

      const customComponents = registry.getComponentsBySource('custom');
      expect(customComponents).toHaveLength(1);
      expect(customComponents[0].manifest.id).toBe('test-button');
    });
  });
});