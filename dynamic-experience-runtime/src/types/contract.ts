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
}

export interface UIElement {
  id: string;
  type: string;
  properties: Record<string, any>;
  dataBindings: DataBinding[];
  eventBindings: EventBinding[];
  children?: UIElement[];
}

export interface OperationBinding {
  id: string;
  operationName: string;
  inputs: InputBinding[];
  outputs: OutputBinding[];
  triggers: TriggerSpec[];
}

export interface DataBinding {
  property: string;
  source: 'operation' | 'state' | 'constant';
  sourceId: string;
  transform?: TransformFunction;
}

export interface EventBinding {
  event: string;
  operationId: string;
  parameters?: Record<string, any>;
}

export interface InputBinding {
  name: string;
  source: 'ui-element' | 'state' | 'constant';
  sourceId: string;
  transform?: TransformFunction;
}

export interface OutputBinding {
  name: string;
  target: 'ui-element' | 'state';
  targetId: string;
  property?: string;
  transform?: TransformFunction;
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