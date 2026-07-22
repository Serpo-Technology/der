/**
 * Contract types - Structured specifications for experiences
 * Requirements: 2.1, 2.3, 2.6, 2.7
 */

export interface Contract {
  name: string;
  version: string;
  elements: UIElement[];
  operations: OperationBinding[];
  layout: LayoutSpec;
  styling: StyleSpec;
  metadata: ContractMetadata;
  /** Seed values for experience state, applied before operation placeholders. */
  initialState?: Record<string, unknown>;
}

export interface UIElement {
  id: string;
  type: string;
  properties: Record<string, any>;
  dataBindings: DataBinding[];
  eventBindings: EventBinding[];
  children?: UIElement[];
  /** Declarative visibility; an array means every condition must hold. */
  visibleWhen?: VisibilityCondition | VisibilityCondition[];
}

export type VisibilityOperator =
  | 'truthy'
  | 'falsy'
  | 'empty'
  | 'notEmpty'
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface VisibilityCondition {
  source: 'state' | 'item';
  sourceId: string;
  operator: VisibilityOperator;
  /** Comparison value for equals/notEquals/gt/gte/lt/lte. */
  value?: unknown;
  /** Transform pipeline applied to the read value before comparison. */
  transforms?: TransformFunction[];
}

export interface OperationBinding {
  id: string;
  operationName: string;
  inputs: InputBinding[];
  outputs: OutputBinding[];
  triggers: TriggerSpec[];
  executionType?: 'builtin' | 'remote' | 'local' | 'repository';
  implementation?: {
    type: 'builtin' | 'remote' | 'local' | 'repository';
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    code?: string;
    repositoryId?: string;
  };
}

export interface DataBinding {
  property: string;
  source: 'operation' | 'state' | 'constant' | 'item';
  sourceId: string;
  /** Typed literal for source 'constant'; sourceId stays the legacy string form. */
  value?: unknown;
  /** Single transform (legacy) or use `transforms` for an ordered pipeline. */
  transform?: TransformFunction;
  transforms?: TransformFunction[];
}

export interface EventBinding {
  event: string;
  operationId: string;
  parameters?: Record<string, any>;
}

export interface InputBinding {
  name: string;
  source: 'ui-element' | 'state' | 'constant' | 'item';
  sourceId: string;
  /** Typed literal for source 'constant'; sourceId stays the legacy string form. */
  value?: unknown;
  /** Single transform (legacy) or use `transforms` for an ordered pipeline. */
  transform?: TransformFunction;
  transforms?: TransformFunction[];
}

export interface OutputBinding {
  name: string;
  target: 'ui-element' | 'state';
  targetId: string;
  property?: string;
  /** Single transform (legacy) or use `transforms` for an ordered pipeline. */
  transform?: TransformFunction;
  transforms?: TransformFunction[];
}

export interface TriggerSpec {
  type: 'event' | 'data-change' | 'timer';
  condition?: string;
  parameters?: Record<string, any>;
}

export interface LayoutSpec {
  type: 'grid' | 'flex' | 'absolute';
  properties: Record<string, any>;
}

export interface StyleSpec {
  theme: string;
  customStyles?: Record<string, any>;
}

export interface ContractMetadata {
  createdAt: Date;
  updatedAt: Date;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
}

export interface TransformFunction {
  type: string;
  parameters: Record<string, any>;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
  code: string;
}

export interface ContractDelta {
  added: UIElement[];
  modified: UIElement[];
  removed: string[];
  operationChanges: OperationBinding[];
}

export interface ContractEdits {
  elementEdits: Record<string, any>;
  operationEdits: Record<string, any>;
  layoutEdits?: LayoutSpec;
  styleEdits?: StyleSpec;
}

export interface ResolvedContract {
  contract: Contract;
  resolvedComponents: Map<string, any>;
  dependencyGraph: DependencyNode[];
}

export interface DependencyNode {
  id: string;
  dependencies: string[];
  resolved: boolean;
}