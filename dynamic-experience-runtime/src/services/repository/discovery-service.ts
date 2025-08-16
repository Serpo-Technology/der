/**
 * Component Discovery Service
 * Requirements: 6.3, 6.4, 7.3, 7.4
 * 
 * Provides advanced component discovery capabilities including
 * capability-based search, semantic matching, and intelligent recommendations.
 */

import type {
  ComponentManifest} from '../../types/component';
import type {
  RepositoryQuery,
  RepositoryResult
} from '../../types/repository';
import { repositoryService } from './repository-service';

export interface DiscoveryQuery {
  // Basic filters
  type?: 'ui-element' | 'operation';
  capabilities?: string[];
  name?: string;
  version?: string;
  
  // Advanced filters
  tags?: string[];
  description?: string;
  
  // Semantic search
  semanticQuery?: string;
  
  // Compatibility filters
  compatibleWith?: string; // Component ID
  dependsOn?: string; // Component ID
  
  // Ranking options
  sortBy?: 'relevance' | 'name' | 'version' | 'popularity' | 'recent';
  sortOrder?: 'asc' | 'desc';
  
  // Pagination
  limit?: number;
  offset?: number;
}

export interface DiscoveryResult<T> extends RepositoryResult<T> {
  query: DiscoveryQuery;
  suggestions?: ComponentManifest[];
  relatedComponents?: ComponentManifest[];
  facets?: {
    capabilities: { [key: string]: number };
    types: { [key: string]: number };
    sources: { [key: string]: number };
  };
}

export interface ComponentRecommendation {
  component: ComponentManifest;
  score: number;
  reasons: string[];
  compatibility: 'full' | 'partial' | 'none';
}

export class DiscoveryService {
  /**
   * Discover components using advanced query capabilities
   */
  async discoverComponents(query: DiscoveryQuery): Promise<DiscoveryResult<ComponentManifest>> {
    // Convert to repository query
    const repoQuery: RepositoryQuery = {
      type: query.type,
      capabilities: query.capabilities,
      name: query.name,
      version: query.version,
      limit: query.limit,
      offset: query.offset
    };

    // Get base results
    let results = await repositoryService.searchComponents(repoQuery);

    // Apply additional filters
    results.items = await this.applyAdvancedFilters(results.items, query);

    // Apply sorting
    results.items = this.sortResults(results.items, query);

    // Generate suggestions and related components
    const suggestions = await this.generateSuggestions(query, results.items);
    const relatedComponents = await this.findRelatedComponents(results.items);

    // Generate facets for filtering UI
    const facets = this.generateFacets(results.items);

    return {
      ...results,
      query,
      suggestions,
      relatedComponents,
      facets
    };
  }

  /**
   * Find components by capability requirements
   */
  async findByCapabilityRequirements(
    requiredCapabilities: string[],
    optionalCapabilities: string[] = [],
    excludeCapabilities: string[] = []
  ): Promise<ComponentRecommendation[]> {
    const allComponents = await repositoryService.listComponents();
    const recommendations: ComponentRecommendation[] = [];

    for (const component of allComponents) {
      const score = this.calculateCapabilityScore(
        component,
        requiredCapabilities,
        optionalCapabilities,
        excludeCapabilities
      );

      if (score.total > 0) {
        const compatibility = this.determineCompatibility(
          component,
          requiredCapabilities,
          optionalCapabilities
        );

        recommendations.push({
          component,
          score: score.total,
          reasons: score.reasons,
          compatibility
        });
      }
    }

    // Sort by score descending
    return recommendations.sort((a, b) => b.score - a.score);
  }

  /**
   * Find components that can work together
   */
  async findCompatibleSets(
    baseComponentId: string,
    targetCapabilities: string[]
  ): Promise<{
    sets: ComponentManifest[][];
    coverage: { [capability: string]: ComponentManifest[] };
  }> {
    const baseComponent = await repositoryService.getComponent(baseComponentId);
    if (!baseComponent) {
      throw new Error(`Base component ${baseComponentId} not found`);
    }

    // Find components for each capability
    const coverage: { [capability: string]: ComponentManifest[] } = {};
    
    for (const capability of targetCapabilities) {
      const components = await repositoryService.queryUIElements({ capabilities: [capability] });
      const operations = await repositoryService.queryOperations({ capabilities: [capability] });
      coverage[capability] = [...components, ...operations];
    }

    // Generate compatible sets (simplified - could be more sophisticated)
    const sets: ComponentManifest[][] = [];
    const maxSets = 5; // Limit number of sets to return

    // For now, create sets by picking one component per capability
    for (let i = 0; i < maxSets; i++) {
      const set: ComponentManifest[] = [baseComponent];
      
      for (const capability of targetCapabilities) {
        const availableComponents = coverage[capability];
        if (availableComponents.length > i) {
          set.push(availableComponents[i]);
        }
      }
      
      if (set.length > 1) {
        sets.push(set);
      }
    }

    return { sets, coverage };
  }

  /**
   * Get component recommendations based on usage patterns
   */
  async getRecommendations(
    contextComponentIds: string[],
    targetType?: 'ui-element' | 'operation'
  ): Promise<ComponentRecommendation[]> {
    const contextComponents = await Promise.all(
      contextComponentIds.map(id => repositoryService.getComponent(id))
    );
    const validContextComponents = contextComponents.filter(c => c !== null) as ComponentManifest[];

    if (validContextComponents.length === 0) {
      return [];
    }

    // Extract capabilities from context components
    const contextCapabilities = new Set<string>();
    validContextComponents.forEach(component => {
      component.capabilities.forEach(cap => contextCapabilities.add(cap));
    });

    // Find components with complementary capabilities
    const allComponents = await repositoryService.listComponents(targetType);
    const recommendations: ComponentRecommendation[] = [];

    for (const component of allComponents) {
      // Skip if already in context
      if (contextComponentIds.includes(component.id)) {
        continue;
      }

      const score = this.calculateRecommendationScore(
        component,
        validContextComponents,
        Array.from(contextCapabilities)
      );

      if (score.total > 0) {
        recommendations.push({
          component,
          score: score.total,
          reasons: score.reasons,
          compatibility: 'partial' // Could be more sophisticated
        });
      }
    }

    return recommendations.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  /**
   * Search components by semantic similarity
   */
  async searchSemantic(
    query: string,
    type?: 'ui-element' | 'operation'
  ): Promise<ComponentManifest[]> {
    // Simple semantic search based on text similarity
    // In a real implementation, this could use embeddings or NLP
    const allComponents = await repositoryService.listComponents(type);
    const queryTokens = this.tokenizeQuery(query);
    
    const scored = allComponents.map(component => {
      const score = this.calculateSemanticScore(component, queryTokens);
      return { component, score };
    });

    return scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.component);
  }

  /**
   * Find components by example
   */
  async findSimilar(
    exampleComponentId: string,
    similarityThreshold: number = 0.5
  ): Promise<ComponentManifest[]> {
    const exampleComponent = await repositoryService.getComponent(exampleComponentId);
    if (!exampleComponent) {
      throw new Error(`Example component ${exampleComponentId} not found`);
    }

    const allComponents = await repositoryService.listComponents(exampleComponent.type);
    const similar: ComponentManifest[] = [];

    for (const component of allComponents) {
      if (component.id === exampleComponentId) continue;

      const similarity = this.calculateSimilarity(exampleComponent, component);
      if (similarity >= similarityThreshold) {
        similar.push(component);
      }
    }

    return similar.sort((a, b) => {
      const simA = this.calculateSimilarity(exampleComponent, a);
      const simB = this.calculateSimilarity(exampleComponent, b);
      return simB - simA;
    });
  }

  /**
   * Apply advanced filters to component results
   */
  private async applyAdvancedFilters(
    components: ComponentManifest[],
    query: DiscoveryQuery
  ): Promise<ComponentManifest[]> {
    let filtered = components;

    // Filter by description
    if (query.description) {
      const descTokens = this.tokenizeQuery(query.description);
      filtered = filtered.filter(component => {
        const componentTokens = this.tokenizeQuery(component.description);
        return descTokens.some(token => 
          componentTokens.some(compToken => 
            compToken.includes(token) || token.includes(compToken)
          )
        );
      });
    }

    // Filter by compatibility
    if (query.compatibleWith) {
      const targetComponent = await repositoryService.getComponent(query.compatibleWith);
      if (targetComponent) {
        filtered = filtered.filter(component => 
          this.areCompatible(component, targetComponent)
        );
      }
    }

    // Filter by dependencies
    if (query.dependsOn) {
      filtered = filtered.filter(component =>
        component.dependencies.some(dep => dep.name === query.dependsOn)
      );
    }

    return filtered;
  }

  /**
   * Sort results based on query criteria
   */
  private sortResults(components: ComponentManifest[], query: DiscoveryQuery): ComponentManifest[] {
    const { sortBy = 'relevance', sortOrder = 'desc' } = query;
    
    const sorted = [...components].sort((a, b) => {
      let comparison = 0;
      
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'version':
          comparison = a.version.localeCompare(b.version);
          break;
        case 'relevance': {
          // Calculate relevance based on capability matches
          const aRelevance = query.capabilities ? 
            query.capabilities.filter(cap => a.capabilities.includes(cap)).length : 0;
          const bRelevance = query.capabilities ? 
            query.capabilities.filter(cap => b.capabilities.includes(cap)).length : 0;
          comparison = aRelevance - bRelevance;
          break;
        }
        default:
          comparison = 0;
      }
      
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    
    return sorted;
  }

  /**
   * Generate component suggestions based on query
   */
  private async generateSuggestions(
    query: DiscoveryQuery,
    currentResults: ComponentManifest[]
  ): Promise<ComponentManifest[]> {
    if (!query.capabilities || query.capabilities.length === 0) {
      return [];
    }

    // Find components with related capabilities
    const relatedCapabilities = await this.findRelatedCapabilities(query.capabilities);
    const suggestions = await repositoryService.searchComponents({
      capabilities: relatedCapabilities,
      type: query.type,
      limit: 5
    });

    // Filter out components already in results
    const currentIds = new Set(currentResults.map(c => c.id));
    return suggestions.items.filter(c => !currentIds.has(c.id));
  }

  /**
   * Find components related to the current results
   */
  private async findRelatedComponents(
    components: ComponentManifest[]
  ): Promise<ComponentManifest[]> {
    if (components.length === 0) return [];

    // Get all capabilities from current components
    const allCapabilities = new Set<string>();
    components.forEach(component => {
      component.capabilities.forEach(cap => allCapabilities.add(cap));
    });

    // Find components with overlapping capabilities
    const related = await repositoryService.searchComponents({
      capabilities: Array.from(allCapabilities).slice(0, 3), // Limit to avoid too broad search
      limit: 5
    });

    // Filter out components already in results
    const currentIds = new Set(components.map(c => c.id));
    return related.items.filter(c => !currentIds.has(c.id));
  }

  /**
   * Generate facets for filtering UI
   */
  private generateFacets(components: ComponentManifest[]) {
    const capabilities: { [key: string]: number } = {};
    const types: { [key: string]: number } = {};
    const sources: { [key: string]: number } = {};

    components.forEach(component => {
      // Count capabilities
      component.capabilities.forEach(cap => {
        capabilities[cap] = (capabilities[cap] || 0) + 1;
      });

      // Count types
      types[component.type] = (types[component.type] || 0) + 1;

      // Count sources (would need registration info)
      sources['custom'] = (sources['custom'] || 0) + 1;
    });

    return { capabilities, types, sources };
  }

  /**
   * Calculate capability-based score for a component
   */
  private calculateCapabilityScore(
    component: ComponentManifest,
    required: string[],
    optional: string[],
    excluded: string[]
  ) {
    let score = 0;
    const reasons: string[] = [];

    // Check required capabilities
    const hasRequired = required.filter(cap => component.capabilities.includes(cap));
    if (hasRequired.length === required.length) {
      score += 100;
      reasons.push(`Has all required capabilities: ${hasRequired.join(', ')}`);
    } else if (hasRequired.length > 0) {
      score += (hasRequired.length / required.length) * 50;
      reasons.push(`Has ${hasRequired.length}/${required.length} required capabilities`);
    }

    // Check optional capabilities
    const hasOptional = optional.filter(cap => component.capabilities.includes(cap));
    if (hasOptional.length > 0) {
      score += (hasOptional.length / optional.length) * 25;
      reasons.push(`Has ${hasOptional.length} optional capabilities: ${hasOptional.join(', ')}`);
    }

    // Check excluded capabilities
    const hasExcluded = excluded.filter(cap => component.capabilities.includes(cap));
    if (hasExcluded.length > 0) {
      score -= hasExcluded.length * 10;
      reasons.push(`Has excluded capabilities: ${hasExcluded.join(', ')}`);
    }

    return { total: Math.max(0, score), reasons };
  }

  /**
   * Determine compatibility level
   */
  private determineCompatibility(
    component: ComponentManifest,
    required: string[],
    optional: string[]
  ): 'full' | 'partial' | 'none' {
    const hasAllRequired = required.every(cap => component.capabilities.includes(cap));
    const hasSomeRequired = required.some(cap => component.capabilities.includes(cap));
    const hasOptional = optional.some(cap => component.capabilities.includes(cap));

    if (hasAllRequired) {
      return 'full';
    } else if (hasSomeRequired || hasOptional) {
      return 'partial';
    } else {
      return 'none';
    }
  }

  /**
   * Calculate recommendation score based on context
   */
  private calculateRecommendationScore(
    component: ComponentManifest,
    contextComponents: ComponentManifest[],
    contextCapabilities: string[]
  ) {
    let score = 0;
    const reasons: string[] = [];

    // Score based on complementary capabilities
    const complementaryCapabilities = component.capabilities.filter(
      cap => !contextCapabilities.includes(cap)
    );
    if (complementaryCapabilities.length > 0) {
      score += complementaryCapabilities.length * 10;
      reasons.push(`Adds new capabilities: ${complementaryCapabilities.slice(0, 3).join(', ')}`);
    }

    // Score based on dependency relationships
    const canUseContext = contextComponents.some(ctx =>
      component.dependencies.some(dep => dep.name === ctx.id)
    );
    if (canUseContext) {
      score += 20;
      reasons.push('Can use existing components');
    }

    const canBeUsedByContext = contextComponents.some(ctx =>
      ctx.dependencies.some(dep => dep.name === component.id)
    );
    if (canBeUsedByContext) {
      score += 15;
      reasons.push('Can be used by existing components');
    }

    return { total: score, reasons };
  }

  /**
   * Calculate semantic similarity score
   */
  private calculateSemanticScore(component: ComponentManifest, queryTokens: string[]): number {
    const componentText = `${component.name} ${component.description}`.toLowerCase();
    const componentTokens = this.tokenizeQuery(componentText);
    
    let matches = 0;
    queryTokens.forEach(queryToken => {
      componentTokens.forEach(compToken => {
        if (compToken.includes(queryToken) || queryToken.includes(compToken)) {
          matches++;
        }
      });
    });

    return matches / Math.max(queryTokens.length, componentTokens.length);
  }

  /**
   * Calculate similarity between two components
   */
  private calculateSimilarity(componentA: ComponentManifest, componentB: ComponentManifest): number {
    // Capability similarity
    const capA = new Set(componentA.capabilities);
    const capB = new Set(componentB.capabilities);
    const intersection = new Set([...capA].filter(x => capB.has(x)));
    const union = new Set([...capA, ...capB]);
    const capSimilarity = intersection.size / union.size;

    // Name similarity (simple)
    const nameA = componentA.name.toLowerCase();
    const nameB = componentB.name.toLowerCase();
    const nameSimilarity = nameA.includes(nameB) || nameB.includes(nameA) ? 0.5 : 0;

    // Type similarity
    const typeSimilarity = componentA.type === componentB.type ? 1 : 0;

    // Weighted average
    return (capSimilarity * 0.6) + (nameSimilarity * 0.2) + (typeSimilarity * 0.2);
  }

  /**
   * Check if two components are compatible
   */
  private areCompatible(componentA: ComponentManifest, componentB: ComponentManifest): boolean {
    // Simple compatibility check - could be more sophisticated
    return componentA.dependencies.some(dep => dep.name === componentB.id) ||
           componentB.dependencies.some(dep => dep.name === componentA.id) ||
           componentA.capabilities.some(cap => componentB.capabilities.includes(cap));
  }

  /**
   * Find capabilities related to the given ones
   */
  private async findRelatedCapabilities(capabilities: string[]): Promise<string[]> {
    // Simple implementation - in practice could use ML or predefined relationships
    const relatedMap: { [key: string]: string[] } = {
      'clickable': ['interactive', 'button', 'action'],
      'styled': ['theme', 'css', 'appearance'],
      'input': ['form', 'validation', 'data-entry'],
      'http': ['api', 'network', 'remote'],
      'async': ['promise', 'callback', 'event']
    };

    const related = new Set<string>();
    capabilities.forEach(cap => {
      const relatedCaps = relatedMap[cap] || [];
      relatedCaps.forEach(relCap => related.add(relCap));
    });

    return Array.from(related);
  }

  /**
   * Tokenize query string
   */
  private tokenizeQuery(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2);
  }
}

// Export singleton instance
export const discoveryService = new DiscoveryService();