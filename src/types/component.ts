/**
 * Component types - UI elements and operations manifests
 * Requirements: 6.1, 6.2, 7.1, 7.2
 */

import type { InputSpec, OutputSpec, OperationImplementation } from './experience';

// Re-export from experience.ts to avoid duplication
export type { InputSpec, OutputSpec, ValidationRule, OperationImplementation } from './experience';

export interface ComponentManifest {
  id: string;
  name: string;
  version: string;
  type: 'ui-element' | 'operation';
  description: string;
  capabilities: string[];
  dependencies: Dependency[];
  schema: JSONSchema;
}

export interface UIElementManifest extends ComponentManifest {
  type: 'ui-element';
  inputs: InputSpec[];
  outputs: OutputSpec[];
  renderFunction: string;
  styleSchema: JSONSchema;
}

export interface OperationManifest extends ComponentManifest {
  type: 'operation';
  inputs: InputSpec[];
  outputs: OutputSpec[];
  executionType: 'remote' | 'local' | 'repository';
  implementation: OperationImplementation;
}

export interface Dependency {
  type: 'ui-element' | 'operation' | 'library';
  name: string;
  version: string;
  optional: boolean;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: any[];
  default?: any;
  properties?: Record<string, JSONSchemaProperty>;
  items?: JSONSchemaProperty;
  required?: string[];
}

export interface ComponentCriteria {
  type?: 'ui-element' | 'operation';
  capabilities?: string[];
  name?: string;
  version?: string;
  tags?: string[];
}