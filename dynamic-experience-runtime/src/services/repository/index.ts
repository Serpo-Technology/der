// Repository service exports
export { RepositoryService, repositoryService } from './repository-service';
export { IndexingService, indexingService } from './indexing-service';
export { ComponentRegistry, componentRegistry } from './component-registry';
export { DiscoveryService, discoveryService } from './discovery-service';
export { CustomComponentManager, customComponentManager } from './custom-component-manager';

// Type exports
export type { SearchIndex } from './indexing-service';
export type { ComponentRegistryOptions, DependencyResolution } from './component-registry';
export type { DiscoveryQuery, DiscoveryResult, ComponentRecommendation } from './discovery-service';
export type { 
  CustomComponentValidation, 
  CustomComponentIntegration, 
  IntegrationStep, 
  CustomComponentTemplate 
} from './custom-component-manager';