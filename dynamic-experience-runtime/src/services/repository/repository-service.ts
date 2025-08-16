/**
 * Repository Service Implementation
 * Requirements: 6.1, 6.2, 6.5
 * 
 * Implements ComponentManifest interfaces for UI elements and operations,
 * creates repository storage using Tauri's file system APIs,
 * and provides indexing system for component discovery and querying.
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  ComponentRepository,
  RepositoryIndex,
  RepositoryQuery,
  RepositoryResult} from '../../types/repository';
import type {
  ComponentManifest,
  UIElementManifest,
  OperationManifest,
  ComponentCriteria
} from '../../types/component';
import { indexingService } from './indexing-service';

export class RepositoryService implements ComponentRepository {
  private index: RepositoryIndex | null = null;
  private readonly indexPath = 'repository/index.json';
  private readonly componentsPath = 'repository/components';

  constructor() {
    this.initializeRepository();
  }

  /**
   * Initialize repository and load index
   */
  private async initializeRepository(): Promise<void> {
    try {
      await this.loadIndex();
      // Build search index from loaded components
      if (this.index) {
        indexingService.buildIndex(this.index.components);
      }
    } catch {
      // Create new index if none exists
      this.index = {
        components: new Map(),
        capabilities: new Map(),
        dependencies: new Map(),
        lastUpdated: new Date()
      };
      await this.saveIndex();
      indexingService.buildIndex(this.index.components);
    }
  }

  /**
   * Load repository index from storage
   */
  private async loadIndex(): Promise<void> {
    try {
      const indexData = await invoke<string>('read_repository_index', {
        path: this.indexPath
      });
      
      const parsed = JSON.parse(indexData);
      this.index = {
        components: new Map(Object.entries(parsed.components || {})),
        capabilities: new Map(Object.entries(parsed.capabilities || {})),
        dependencies: new Map(Object.entries(parsed.dependencies || {})),
        lastUpdated: new Date(parsed.lastUpdated || Date.now())
      };
    } catch (error) {
      throw new Error(`Failed to load repository index: ${error}`);
    }
  }

  /**
   * Save repository index to storage
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;

    try {
      const indexData = {
        components: Object.fromEntries(this.index.components),
        capabilities: Object.fromEntries(this.index.capabilities),
        dependencies: Object.fromEntries(this.index.dependencies),
        lastUpdated: this.index.lastUpdated.toISOString()
      };

      await invoke('write_repository_index', {
        path: this.indexPath,
        data: JSON.stringify(indexData, null, 2)
      });
    } catch (error) {
      throw new Error(`Failed to save repository index: ${error}`);
    }
  }

  /**
   * Update index with component information
   */
  private updateIndex(manifest: ComponentManifest): void {
    if (!this.index) return;

    // Add component to index
    this.index.components.set(manifest.id, manifest);

    // Update capabilities index
    manifest.capabilities.forEach(capability => {
      const existing = this.index!.capabilities.get(capability) || [];
      if (!existing.includes(manifest.id)) {
        existing.push(manifest.id);
        this.index!.capabilities.set(capability, existing);
      }
    });

    // Update dependencies index
    const dependencyIds = manifest.dependencies.map(dep => dep.name);
    this.index.dependencies.set(manifest.id, dependencyIds);

    this.index.lastUpdated = new Date();

    // Update search index
    indexingService.indexComponent(manifest.id, manifest);
  }

  /**
   * Remove component from index
   */
  private removeFromIndex(componentId: string): void {
    if (!this.index) return;

    const manifest = this.index.components.get(componentId);
    if (!manifest) return;

    // Remove from search index first
    indexingService.removeFromIndex(componentId, manifest);

    // Remove from components
    this.index.components.delete(componentId);

    // Remove from capabilities index
    manifest.capabilities.forEach(capability => {
      const existing = this.index!.capabilities.get(capability) || [];
      const filtered = existing.filter(id => id !== componentId);
      if (filtered.length > 0) {
        this.index!.capabilities.set(capability, filtered);
      } else {
        this.index!.capabilities.delete(capability);
      }
    });

    // Remove from dependencies index
    this.index.dependencies.delete(componentId);

    this.index.lastUpdated = new Date();
  }

  /**
   * Query UI elements based on criteria
   */
  async queryUIElements(criteria: ComponentCriteria): Promise<UIElementManifest[]> {
    await this.ensureIndexLoaded();
    
    const allComponents = Array.from(this.index!.components.values());
    const uiElements = allComponents.filter(
      (component): component is UIElementManifest => 
        component.type === 'ui-element'
    );

    return this.filterComponents(uiElements, criteria) as UIElementManifest[];
  }

  /**
   * Query operations based on criteria
   */
  async queryOperations(criteria: ComponentCriteria): Promise<OperationManifest[]> {
    await this.ensureIndexLoaded();
    
    const allComponents = Array.from(this.index!.components.values());
    const operations = allComponents.filter(
      (component): component is OperationManifest => 
        component.type === 'operation'
    );

    return this.filterComponents(operations, criteria) as OperationManifest[];
  }

  /**
   * Register a new component in the repository
   */
  async registerComponent(manifest: ComponentManifest): Promise<void> {
    await this.ensureIndexLoaded();

    try {
      // Validate manifest
      this.validateManifest(manifest);

      // Save component manifest to storage
      const componentPath = `${this.componentsPath}/${manifest.id}-${manifest.version}.json`;
      await invoke('write_component_manifest', {
        path: componentPath,
        data: JSON.stringify(manifest, null, 2)
      });

      // Update index
      this.updateIndex(manifest);
      await this.saveIndex();

    } catch (error) {
      throw new Error(`Failed to register component: ${error}`);
    }
  }

  /**
   * Get a specific component by ID and version
   */
  async getComponent(id: string, version?: string): Promise<ComponentManifest | null> {
    await this.ensureIndexLoaded();

    const component = this.index!.components.get(id);
    if (!component) return null;

    if (version && component.version !== version) {
      // Try to load specific version from storage
      try {
        const componentPath = `${this.componentsPath}/${id}-${version}.json`;
        const manifestData = await invoke<string>('read_component_manifest', {
          path: componentPath
        });
        return JSON.parse(manifestData);
      } catch {
        return null;
      }
    }

    return component;
  }

  /**
   * Update an existing component
   */
  async updateComponent(id: string, manifest: ComponentManifest): Promise<void> {
    await this.ensureIndexLoaded();

    if (manifest.id !== id) {
      throw new Error('Component ID mismatch');
    }

    // Remove old version from index
    this.removeFromIndex(id);

    // Register updated component
    await this.registerComponent(manifest);
  }

  /**
   * Delete a component from the repository
   */
  async deleteComponent(id: string, version?: string): Promise<void> {
    await this.ensureIndexLoaded();

    try {
      // Remove from storage
      const componentPath = version 
        ? `${this.componentsPath}/${id}-${version}.json`
        : `${this.componentsPath}/${id}-*.json`;
      
      await invoke('delete_component_manifest', {
        path: componentPath
      });

      // Remove from index
      this.removeFromIndex(id);
      await this.saveIndex();

    } catch (error) {
      throw new Error(`Failed to delete component: ${error}`);
    }
  }

  /**
   * List all components, optionally filtered by type
   */
  async listComponents(type?: 'ui-element' | 'operation'): Promise<ComponentManifest[]> {
    await this.ensureIndexLoaded();

    const allComponents = Array.from(this.index!.components.values());
    
    if (type) {
      return allComponents.filter(component => component.type === type);
    }

    return allComponents;
  }

  /**
   * Advanced search using the indexing service
   */
  async searchComponents(query: RepositoryQuery): Promise<RepositoryResult<ComponentManifest>> {
    await this.ensureIndexLoaded();
    return indexingService.searchComponents(this.index!.components, query);
  }

  /**
   * Find components that depend on a given component
   */
  async findDependents(componentId: string): Promise<ComponentManifest[]> {
    await this.ensureIndexLoaded();
    
    const dependentIds = indexingService.findDependents(componentId);
    const dependents: ComponentManifest[] = [];
    
    dependentIds.forEach(id => {
      const component = this.index!.components.get(id);
      if (component) {
        dependents.push(component);
      }
    });
    
    return dependents;
  }

  /**
   * Find all dependencies of a component (recursive)
   */
  async findAllDependencies(componentId: string): Promise<ComponentManifest[]> {
    await this.ensureIndexLoaded();
    
    const dependencyIds = indexingService.findAllDependencies(componentId);
    const dependencies: ComponentManifest[] = [];
    
    dependencyIds.forEach(id => {
      const component = this.index!.components.get(id);
      if (component) {
        dependencies.push(component);
      }
    });
    
    return dependencies;
  }

  /**
   * Check for circular dependencies
   */
  async hasCircularDependencies(componentId: string): Promise<boolean> {
    await this.ensureIndexLoaded();
    return indexingService.hasCircularDependencies(componentId);
  }

  /**
   * Get repository statistics
   */
  async getRepositoryStats(): Promise<{
    totalComponents: number;
    totalUIElements: number;
    totalOperations: number;
    totalCapabilities: number;
    totalDependencies: number;
    lastUpdate: Date;
  }> {
    await this.ensureIndexLoaded();
    
    const indexStats = indexingService.getIndexStats();
    const allComponents = Array.from(this.index!.components.values());
    const uiElements = allComponents.filter(c => c.type === 'ui-element');
    const operations = allComponents.filter(c => c.type === 'operation');
    
    return {
      totalComponents: indexStats.totalComponents,
      totalUIElements: uiElements.length,
      totalOperations: operations.length,
      totalCapabilities: indexStats.totalCapabilities,
      totalDependencies: indexStats.totalDependencies,
      lastUpdate: indexStats.lastUpdate
    };
  }

  /**
   * Ensure index is loaded
   */
  private async ensureIndexLoaded(): Promise<void> {
    if (!this.index) {
      await this.initializeRepository();
    }
  }

  /**
   * Filter components based on criteria
   */
  private filterComponents<T extends ComponentManifest>(
    components: T[], 
    criteria: ComponentCriteria
  ): T[] {
    return components.filter(component => {
      // Filter by type
      if (criteria.type && component.type !== criteria.type) {
        return false;
      }

      // Filter by name
      if (criteria.name && !component.name.toLowerCase().includes(criteria.name.toLowerCase())) {
        return false;
      }

      // Filter by version
      if (criteria.version && component.version !== criteria.version) {
        return false;
      }

      // Filter by capabilities
      if (criteria.capabilities && criteria.capabilities.length > 0) {
        const hasAllCapabilities = criteria.capabilities.every(capability =>
          component.capabilities.includes(capability)
        );
        if (!hasAllCapabilities) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Validate component manifest
   */
  private validateManifest(manifest: ComponentManifest): void {
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.type) {
      throw new Error('Component manifest missing required fields');
    }

    if (!['ui-element', 'operation'].includes(manifest.type)) {
      throw new Error('Invalid component type');
    }

    if (!Array.isArray(manifest.capabilities)) {
      throw new Error('Component capabilities must be an array');
    }

    if (!Array.isArray(manifest.dependencies)) {
      throw new Error('Component dependencies must be an array');
    }

    // Validate dependencies
    manifest.dependencies.forEach(dep => {
      if (!dep.name || !dep.version || !dep.type) {
        throw new Error('Invalid dependency specification');
      }
    });
  }
}

// Export singleton instance
export const repositoryService = new RepositoryService();