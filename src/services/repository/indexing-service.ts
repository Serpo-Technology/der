/**
 * Repository Indexing Service
 * Requirements: 6.5
 * 
 * Provides advanced indexing system for component discovery and querying
 * with capability-based search, dependency resolution, and performance optimization.
 */

import type {
  ComponentManifest} from '../../types/component';
import type {
  RepositoryQuery,
  RepositoryResult
} from '../../types/repository';

export interface SearchIndex {
  // Full-text search index for component names and descriptions
  textIndex: Map<string, Set<string>>; // term -> component IDs
  
  // Capability-based index for fast capability queries
  capabilityIndex: Map<string, Set<string>>; // capability -> component IDs
  
  // Dependency graph for dependency resolution
  dependencyGraph: Map<string, Set<string>>; // component ID -> dependency IDs
  reverseDependencyGraph: Map<string, Set<string>>; // dependency ID -> dependent IDs
  
  // Type-based index for filtering by component type
  typeIndex: Map<'ui-element' | 'operation', Set<string>>; // type -> component IDs
  
  // Version index for version-specific queries
  versionIndex: Map<string, Map<string, string>>; // component name -> version -> component ID
}

export class IndexingService {
  private searchIndex: SearchIndex;
  private lastIndexUpdate: Date;

  constructor() {
    this.searchIndex = {
      textIndex: new Map(),
      capabilityIndex: new Map(),
      dependencyGraph: new Map(),
      reverseDependencyGraph: new Map(),
      typeIndex: new Map(),
      versionIndex: new Map()
    };
    this.lastIndexUpdate = new Date();
  }

  /**
   * Build search index from repository components
   */
  buildIndex(components: Map<string, ComponentManifest>): void {
    // Clear existing indexes
    this.clearIndexes();

    // Build indexes for each component
    for (const [id, manifest] of components) {
      this.indexComponent(id, manifest);
    }

    this.lastIndexUpdate = new Date();
  }

  /**
   * Add a single component to the search index
   */
  indexComponent(id: string, manifest: ComponentManifest): void {
    // Text index - tokenize name and description
    const textTokens = this.tokenizeText(`${manifest.name} ${manifest.description}`);
    textTokens.forEach(token => {
      if (!this.searchIndex.textIndex.has(token)) {
        this.searchIndex.textIndex.set(token, new Set());
      }
      this.searchIndex.textIndex.get(token)!.add(id);
    });

    // Capability index
    manifest.capabilities.forEach(capability => {
      if (!this.searchIndex.capabilityIndex.has(capability)) {
        this.searchIndex.capabilityIndex.set(capability, new Set());
      }
      this.searchIndex.capabilityIndex.get(capability)!.add(id);
    });

    // Dependency graph
    const dependencyIds = new Set(manifest.dependencies.map(dep => dep.name));
    this.searchIndex.dependencyGraph.set(id, dependencyIds);

    // Reverse dependency graph
    dependencyIds.forEach(depId => {
      if (!this.searchIndex.reverseDependencyGraph.has(depId)) {
        this.searchIndex.reverseDependencyGraph.set(depId, new Set());
      }
      this.searchIndex.reverseDependencyGraph.get(depId)!.add(id);
    });

    // Type index
    if (!this.searchIndex.typeIndex.has(manifest.type)) {
      this.searchIndex.typeIndex.set(manifest.type, new Set());
    }
    this.searchIndex.typeIndex.get(manifest.type)!.add(id);

    // Version index
    if (!this.searchIndex.versionIndex.has(manifest.name)) {
      this.searchIndex.versionIndex.set(manifest.name, new Map());
    }
    this.searchIndex.versionIndex.get(manifest.name)!.set(manifest.version, id);
  }

  /**
   * Remove a component from the search index
   */
  removeFromIndex(id: string, manifest: ComponentManifest): void {
    // Remove from text index
    const textTokens = this.tokenizeText(`${manifest.name} ${manifest.description}`);
    textTokens.forEach(token => {
      const tokenSet = this.searchIndex.textIndex.get(token);
      if (tokenSet) {
        tokenSet.delete(id);
        if (tokenSet.size === 0) {
          this.searchIndex.textIndex.delete(token);
        }
      }
    });

    // Remove from capability index
    manifest.capabilities.forEach(capability => {
      const capabilitySet = this.searchIndex.capabilityIndex.get(capability);
      if (capabilitySet) {
        capabilitySet.delete(id);
        if (capabilitySet.size === 0) {
          this.searchIndex.capabilityIndex.delete(capability);
        }
      }
    });

    // Remove from dependency graphs
    const dependencies = this.searchIndex.dependencyGraph.get(id);
    if (dependencies) {
      dependencies.forEach(depId => {
        const reverseDeps = this.searchIndex.reverseDependencyGraph.get(depId);
        if (reverseDeps) {
          reverseDeps.delete(id);
          if (reverseDeps.size === 0) {
            this.searchIndex.reverseDependencyGraph.delete(depId);
          }
        }
      });
      this.searchIndex.dependencyGraph.delete(id);
    }

    // Remove from type index
    const typeSet = this.searchIndex.typeIndex.get(manifest.type);
    if (typeSet) {
      typeSet.delete(id);
      if (typeSet.size === 0) {
        this.searchIndex.typeIndex.delete(manifest.type);
      }
    }

    // Remove from version index
    const versionMap = this.searchIndex.versionIndex.get(manifest.name);
    if (versionMap) {
      versionMap.delete(manifest.version);
      if (versionMap.size === 0) {
        this.searchIndex.versionIndex.delete(manifest.name);
      }
    }
  }

  /**
   * Search components using advanced query capabilities
   */
  searchComponents(
    components: Map<string, ComponentManifest>,
    query: RepositoryQuery
  ): RepositoryResult<ComponentManifest> {
    let candidateIds = new Set<string>();
    let isFirstFilter = true;

    // Apply type filter
    if (query.type) {
      const typeIds = this.searchIndex.typeIndex.get(query.type) || new Set();
      candidateIds = isFirstFilter ? new Set(typeIds) : this.intersectSets(candidateIds, typeIds);
      isFirstFilter = false;
    }

    // Apply capability filters
    if (query.capabilities && query.capabilities.length > 0) {
      for (const capability of query.capabilities) {
        const capabilityIds = this.searchIndex.capabilityIndex.get(capability) || new Set();
        candidateIds = isFirstFilter ? new Set(capabilityIds) : this.intersectSets(candidateIds, capabilityIds);
        isFirstFilter = false;
      }
    }

    // Apply name filter (text search)
    if (query.name) {
      const nameTokens = this.tokenizeText(query.name);
      const nameIds = new Set<string>();
      
      nameTokens.forEach(token => {
        const tokenIds = this.searchIndex.textIndex.get(token) || new Set();
        tokenIds.forEach(id => nameIds.add(id));
      });

      candidateIds = isFirstFilter ? nameIds : this.intersectSets(candidateIds, nameIds);
      isFirstFilter = false;
    }

    // If no filters applied, use all components
    if (isFirstFilter) {
      candidateIds = new Set(components.keys());
    }

    // Apply version filter
    if (query.version) {
      candidateIds = new Set(
        Array.from(candidateIds).filter(id => {
          const component = components.get(id);
          return component && component.version === query.version;
        })
      );
    }

    // Convert to array and apply pagination
    const allResults = Array.from(candidateIds)
      .map(id => components.get(id))
      .filter((component): component is ComponentManifest => component !== undefined);

    const total = allResults.length;
    const offset = query.offset || 0;
    const limit = query.limit || total;
    
    const paginatedResults = allResults.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return {
      items: paginatedResults,
      total,
      hasMore
    };
  }

  /**
   * Find components that depend on a given component
   */
  findDependents(componentId: string): Set<string> {
    return this.searchIndex.reverseDependencyGraph.get(componentId) || new Set();
  }

  /**
   * Find all dependencies of a component (recursive)
   */
  findAllDependencies(componentId: string, visited = new Set<string>()): Set<string> {
    if (visited.has(componentId)) {
      return new Set(); // Circular dependency detected
    }

    visited.add(componentId);
    const directDeps = this.searchIndex.dependencyGraph.get(componentId) || new Set();
    const allDeps = new Set(directDeps);

    // Recursively find dependencies of dependencies
    directDeps.forEach(depId => {
      const transitiveDeps = this.findAllDependencies(depId, new Set(visited));
      transitiveDeps.forEach(dep => allDeps.add(dep));
    });

    return allDeps;
  }

  /**
   * Check for circular dependencies
   */
  hasCircularDependencies(componentId: string): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    return this.detectCircularDependency(componentId, visited, recursionStack);
  }

  /**
   * Get index statistics
   */
  getIndexStats(): {
    totalComponents: number;
    totalCapabilities: number;
    totalDependencies: number;
    lastUpdate: Date;
  } {
    const totalComponents = Array.from(this.searchIndex.typeIndex.values())
      .reduce((sum, set) => sum + set.size, 0);
    
    const totalCapabilities = this.searchIndex.capabilityIndex.size;
    const totalDependencies = this.searchIndex.dependencyGraph.size;

    return {
      totalComponents,
      totalCapabilities,
      totalDependencies,
      lastUpdate: this.lastIndexUpdate
    };
  }

  /**
   * Clear all indexes
   */
  private clearIndexes(): void {
    this.searchIndex.textIndex.clear();
    this.searchIndex.capabilityIndex.clear();
    this.searchIndex.dependencyGraph.clear();
    this.searchIndex.reverseDependencyGraph.clear();
    this.searchIndex.typeIndex.clear();
    this.searchIndex.versionIndex.clear();
  }

  /**
   * Tokenize text for search indexing
   */
  private tokenizeText(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2); // Filter out very short tokens
  }

  /**
   * Intersect two sets
   */
  private intersectSets<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const intersection = new Set<T>();
    setA.forEach(item => {
      if (setB.has(item)) {
        intersection.add(item);
      }
    });
    return intersection;
  }

  /**
   * Detect circular dependency using DFS
   */
  private detectCircularDependency(
    componentId: string,
    visited: Set<string>,
    recursionStack: Set<string>
  ): boolean {
    visited.add(componentId);
    recursionStack.add(componentId);

    const dependencies = this.searchIndex.dependencyGraph.get(componentId) || new Set();
    
    for (const depId of dependencies) {
      if (!visited.has(depId)) {
        if (this.detectCircularDependency(depId, visited, recursionStack)) {
          return true;
        }
      } else if (recursionStack.has(depId)) {
        return true; // Circular dependency found
      }
    }

    recursionStack.delete(componentId);
    return false;
  }
}

export const indexingService = new IndexingService();