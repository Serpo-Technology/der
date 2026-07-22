/**
 * Component Registry Service
 * Requirements: 6.3, 6.4, 7.3, 7.4
 * 
 * Creates component registration API for adding new UI elements and operations,
 * writes query system that finds components based on capabilities,
 * and implements dependency management for component relationships.
 */

import type {
  ComponentManifest,
  UIElementManifest,
  OperationManifest,
  ComponentCriteria,
  Dependency
} from '../../types/component';
import type {
  RepositoryQuery,
  RepositoryResult,
  ComponentRegistration} from '../../types/repository';
import { repositoryService } from './repository-service';
import { indexingService } from './indexing-service';

export interface ComponentRegistryOptions {
  validateDependencies?: boolean;
  allowOverwrite?: boolean;
  source?: 'built-in' | 'custom' | 'external';
}

export interface DependencyResolution {
  resolved: ComponentManifest[];
  missing: Dependency[];
  circular: string[];
}

export class ComponentRegistry {
  private registrations: Map<string, ComponentRegistration> = new Map();

  /**
   * Register a new UI element component
   */
  async registerUIElement(
    manifest: UIElementManifest,
    options: ComponentRegistryOptions = {}
  ): Promise<void> {
    await this.registerComponent(manifest, options);
  }

  /**
   * Register a new operation component
   */
  async registerOperation(
    manifest: OperationManifest,
    options: ComponentRegistryOptions = {}
  ): Promise<void> {
    await this.registerComponent(manifest, options);
  }

  /**
   * Register a component with validation and dependency checking
   */
  async registerComponent(
    manifest: ComponentManifest,
    options: ComponentRegistryOptions = {}
  ): Promise<void> {
    const {
      validateDependencies = true,
      allowOverwrite = false,
      source = 'custom'
    } = options;

    try {
      // Check if component already exists
      const existing = await repositoryService.getComponent(manifest.id);
      if (existing && !allowOverwrite) {
        throw new Error(`Component ${manifest.id} already exists. Use allowOverwrite option to replace.`);
      }

      // Validate component manifest
      this.validateComponentManifest(manifest);

      // Validate dependencies if requested
      if (validateDependencies) {
        const dependencyResult = await this.resolveDependencies(manifest);
        if (dependencyResult.missing.length > 0) {
          throw new Error(
            `Missing dependencies: ${dependencyResult.missing.map(d => d.name).join(', ')}`
          );
        }
        if (dependencyResult.circular.length > 0) {
          throw new Error(
            `Circular dependencies detected: ${dependencyResult.circular.join(' -> ')}`
          );
        }
      }

      // Register component in repository
      await repositoryService.registerComponent(manifest);

      // Track registration
      const registration: ComponentRegistration = {
        manifest,
        source,
        registeredAt: new Date(),
        registeredBy: 'system' // Could be extended to track user
      };
      this.registrations.set(manifest.id, registration);

    } catch (error) {
      throw new Error(`Failed to register component ${manifest.id}: ${error}`);
    }
  }

  /**
   * Unregister a component
   */
  async unregisterComponent(componentId: string): Promise<void> {
    try {
      // Check for dependents before removing
      const dependents = await repositoryService.findDependents(componentId);
      if (dependents.length > 0) {
        throw new Error(
          `Cannot remove component ${componentId}. It is used by: ${dependents.map(d => d.id).join(', ')}`
        );
      }

      // Remove from repository
      await repositoryService.deleteComponent(componentId);

      // Remove registration tracking
      this.registrations.delete(componentId);

    } catch (error) {
      throw new Error(`Failed to unregister component ${componentId}: ${error}`);
    }
  }

  /**
   * Find components by capabilities
   */
  async findByCapabilities(capabilities: string[]): Promise<ComponentManifest[]> {
    const criteria: ComponentCriteria = { capabilities };
    
    const uiElements = await repositoryService.queryUIElements(criteria);
    const operations = await repositoryService.queryOperations(criteria);
    
    return [...uiElements, ...operations];
  }

  /**
   * Find components by type and capabilities
   */
  async findByTypeAndCapabilities(
    type: 'ui-element' | 'operation',
    capabilities: string[]
  ): Promise<ComponentManifest[]> {
    const criteria: ComponentCriteria = { type, capabilities };
    
    if (type === 'ui-element') {
      return await repositoryService.queryUIElements(criteria);
    } else {
      return await repositoryService.queryOperations(criteria);
    }
  }

  /**
   * Advanced component search with multiple criteria
   */
  async searchComponents(query: RepositoryQuery): Promise<RepositoryResult<ComponentManifest>> {
    return await repositoryService.searchComponents(query);
  }

  /**
   * Find compatible components for a given component
   */
  async findCompatibleComponents(componentId: string): Promise<{
    canUse: ComponentManifest[]; // Components this component can use
    canBeUsedBy: ComponentManifest[]; // Components that can use this component
  }> {
    const component = await repositoryService.getComponent(componentId);
    if (!component) {
      throw new Error(`Component ${componentId} not found`);
    }

    // Find components this component can use (based on its dependencies)
    const canUse: ComponentManifest[] = [];
    for (const dep of component.dependencies) {
      const depComponent = await repositoryService.getComponent(dep.name);
      if (depComponent) {
        canUse.push(depComponent);
      }
    }

    // Find components that can use this component
    const canBeUsedBy = await repositoryService.findDependents(componentId);

    return { canUse, canBeUsedBy };
  }

  /**
   * Get component suggestions based on capabilities needed
   */
  async suggestComponents(
    neededCapabilities: string[],
    excludeIds: string[] = []
  ): Promise<{
    exact: ComponentManifest[]; // Components with all needed capabilities
    partial: ComponentManifest[]; // Components with some needed capabilities
  }> {
    const allComponents = await repositoryService.listComponents();
    const filtered = allComponents.filter(c => !excludeIds.includes(c.id));

    const exact: ComponentManifest[] = [];
    const partial: ComponentManifest[] = [];

    for (const component of filtered) {
      const hasAll = neededCapabilities.every(cap => 
        component.capabilities.includes(cap)
      );
      const hasSome = neededCapabilities.some(cap => 
        component.capabilities.includes(cap)
      );

      if (hasAll) {
        exact.push(component);
      } else if (hasSome) {
        partial.push(component);
      }
    }

    return { exact, partial };
  }

  /**
   * Resolve component dependencies
   */
  async resolveDependencies(component: ComponentManifest): Promise<DependencyResolution> {
    const resolved: ComponentManifest[] = [];
    const missing: Dependency[] = [];
    const circular: string[] = [];

    // Check for circular dependencies
    const hasCircular = await indexingService.hasCircularDependencies(component.id);
    if (hasCircular) {
      circular.push(component.id);
    }

    // Resolve each dependency
    for (const dep of component.dependencies) {
      const depComponent = await repositoryService.getComponent(dep.name, dep.version);
      
      if (depComponent) {
        resolved.push(depComponent);
      } else if (!dep.optional) {
        missing.push(dep);
      }
    }

    return { resolved, missing, circular };
  }

  /**
   * Get dependency tree for a component
   */
  async getDependencyTree(componentId: string): Promise<{
    component: ComponentManifest;
    dependencies: ComponentManifest[];
    dependents: ComponentManifest[];
    allDependencies: ComponentManifest[];
  }> {
    const component = await repositoryService.getComponent(componentId);
    if (!component) {
      throw new Error(`Component ${componentId} not found`);
    }

    const dependencies = await this.getDirectDependencies(component);
    const dependents = await repositoryService.findDependents(componentId);
    const allDependencies = await repositoryService.findAllDependencies(componentId);

    return {
      component,
      dependencies,
      dependents,
      allDependencies
    };
  }

  /**
   * Validate component dependencies are available
   */
  async validateDependencies(component: ComponentManifest): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    for (const dep of component.dependencies) {
      const depComponent = await repositoryService.getComponent(dep.name, dep.version);
      
      if (!depComponent && !dep.optional) {
        errors.push(`Required dependency not found: ${dep.name}@${dep.version}`);
      }

      if (depComponent && depComponent.type !== dep.type) {
        errors.push(`Dependency type mismatch: ${dep.name} expected ${dep.type}, found ${depComponent.type}`);
      }
    }

    // Check for circular dependencies
    const hasCircular = await indexingService.hasCircularDependencies(component.id);
    if (hasCircular) {
      errors.push(`Circular dependency detected for component: ${component.id}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get registration information for a component
   */
  getRegistrationInfo(componentId: string): ComponentRegistration | null {
    return this.registrations.get(componentId) || null;
  }

  /**
   * List all registered components with their registration info
   */
  listRegistrations(): ComponentRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * Get components by source
   */
  getComponentsBySource(source: 'built-in' | 'custom' | 'external'): ComponentRegistration[] {
    return Array.from(this.registrations.values()).filter(reg => reg.source === source);
  }

  /**
   * Validate component manifest structure
   */
  private validateComponentManifest(manifest: ComponentManifest): void {
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.type) {
      throw new Error('Component manifest missing required fields: id, name, version, type');
    }

    if (!['ui-element', 'operation'].includes(manifest.type)) {
      throw new Error(`Invalid component type: ${manifest.type}`);
    }

    if (!Array.isArray(manifest.capabilities)) {
      throw new Error('Component capabilities must be an array');
    }

    if (!Array.isArray(manifest.dependencies)) {
      throw new Error('Component dependencies must be an array');
    }

    // Validate dependencies structure
    for (const dep of manifest.dependencies) {
      if (!dep.name || !dep.version || !dep.type) {
        throw new Error('Invalid dependency structure: name, version, and type are required');
      }
      
      if (!['ui-element', 'operation', 'library'].includes(dep.type)) {
        throw new Error(`Invalid dependency type: ${dep.type}`);
      }
    }

    // Type-specific validation
    if (manifest.type === 'ui-element') {
      const uiManifest = manifest as UIElementManifest;
      if (!uiManifest.renderFunction) {
        throw new Error('UI element manifest missing renderFunction');
      }
      if (!uiManifest.inputs || !uiManifest.outputs) {
        throw new Error('UI element manifest missing inputs or outputs');
      }
    }

    if (manifest.type === 'operation') {
      const opManifest = manifest as OperationManifest;
      if (!opManifest.executionType) {
        throw new Error('Operation manifest missing executionType');
      }
      if (!['builtin', 'remote', 'local', 'repository'].includes(opManifest.executionType)) {
        throw new Error(`Invalid operation executionType: ${opManifest.executionType}`);
      }
      if (!opManifest.inputs || !opManifest.outputs) {
        throw new Error('Operation manifest missing inputs or outputs');
      }
    }
  }

  /**
   * Get direct dependencies for a component
   */
  private async getDirectDependencies(component: ComponentManifest): Promise<ComponentManifest[]> {
    const dependencies: ComponentManifest[] = [];
    
    for (const dep of component.dependencies) {
      const depComponent = await repositoryService.getComponent(dep.name, dep.version);
      if (depComponent) {
        dependencies.push(depComponent);
      }
    }
    
    return dependencies;
  }
}

// Export singleton instance
export const componentRegistry = new ComponentRegistry();