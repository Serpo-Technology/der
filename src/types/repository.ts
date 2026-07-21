/**
 * Repository types - Component storage and discovery
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { ComponentManifest, UIElementManifest, OperationManifest, ComponentCriteria } from './component';

export interface ComponentRepository {
  queryUIElements(criteria: ComponentCriteria): Promise<UIElementManifest[]>;
  queryOperations(criteria: ComponentCriteria): Promise<OperationManifest[]>;
  registerComponent(manifest: ComponentManifest): Promise<void>;
  getComponent(id: string, version?: string): Promise<ComponentManifest | null>;
  updateComponent(id: string, manifest: ComponentManifest): Promise<void>;
  deleteComponent(id: string, version?: string): Promise<void>;
  listComponents(type?: 'ui-element' | 'operation'): Promise<ComponentManifest[]>;
}

export interface RepositoryIndex {
  components: Map<string, ComponentManifest>;
  capabilities: Map<string, string[]>; // capability -> component IDs
  dependencies: Map<string, string[]>; // component ID -> dependency IDs
  lastUpdated: Date;
}

export interface RepositoryQuery {
  type?: 'ui-element' | 'operation';
  capabilities?: string[];
  name?: string;
  version?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface RepositoryResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export interface ComponentRegistration {
  manifest: ComponentManifest;
  source: 'built-in' | 'custom' | 'external';
  registeredAt: Date;
  registeredBy?: string;
}

export interface RepositoryError {
  code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'DEPENDENCY_ERROR' | 'STORAGE_ERROR';
  message: string;
  details?: any;
}