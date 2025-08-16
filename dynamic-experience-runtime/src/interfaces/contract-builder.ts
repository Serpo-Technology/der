/**
 * Contract Builder interface - Contract validation and optimization
 * Requirements: 2.1, 2.2, 2.5, 2.6
 */

import { Contract, ValidationResult } from '../types/contract';
import { ResolvedContract } from '../types/contract';

export interface ContractBuilder {
  validateContract(contract: Contract): Promise<ValidationResult>;
  resolveComponents(contract: Contract): Promise<ResolvedContract>;
  optimizeExecutionOrder(contract: Contract): Promise<Contract>;
  buildFromBlueprint(blueprint: any): Promise<Contract>;
}

export interface ComponentResolver {
  resolveUIElements(contract: Contract): Promise<Map<string, any>>;
  resolveOperations(contract: Contract): Promise<Map<string, any>>;
  validateDependencies(contract: Contract): Promise<ValidationResult>;
}

export interface ExecutionOptimizer {
  analyzeOperationDependencies(contract: Contract): DependencyGraph;
  optimizeOperationOrder(contract: Contract): Contract;
  identifyParallelOperations(contract: Contract): string[][];
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface DependencyNode {
  id: string;
  type: 'ui-element' | 'operation';
  dependencies: string[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'data' | 'event' | 'lifecycle';
}