/**
 * Experience types - Runtime experience management
 * Requirements: 3.1, 3.2, 9.1
 */

import React from 'react';
import { Contract } from './contract';
import { Blueprint } from './blueprint';

export interface Experience {
  // Unified ID (both for compatibility)
  id: string;
  
  // Core properties
  contract: Contract;
  state: ExperienceState | Record<string, any>;
  
  // Runtime-specific (optional)
  reactComponent?: React.ComponentType;
  operations?: Map<string, Operation>;
  
  // Persistence-specific
  metadata?: {
    createdAt: Date;
    updatedAt: Date;
    version: string;
    userId?: string;
    collection?: string;
  };
  
  // Editor-specific (optional)
  blueprint?: Blueprint;
  lastModified?: Date;
  pendingConflicts?: any[];
}

export interface ExperienceState {
  data: Record<string, any>;
  loading: Record<string, boolean>;
  errors: Record<string, Error>;
  lastUpdated: Date;
}

export interface Operation {
  id: string;
  name: string;
  type: 'remote' | 'local' | 'repository';
  implementation: OperationImplementation;
  inputs: InputSpec[];
  outputs: OutputSpec[];
}

export interface OperationImplementation {
  type: 'remote' | 'local' | 'repository';
  endpoint?: string;
  method?: string;
  headers?: Record<string, string>;
  code?: string;
  repositoryId?: string;
}

export interface InputSpec {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  validation?: ValidationRule[];
}

export interface OutputSpec {
  name: string;
  type: string;
  description?: string;
}

export interface ValidationRule {
  type: 'required' | 'min' | 'max' | 'pattern' | 'custom';
  value?: any;
  message: string;
}

export interface ExperienceUpdate {
  blueprint?: any; // Will be defined in blueprint.ts
  contract?: Contract;
  preserveUserEdits: boolean;
}

// ResolvedContract and DependencyNode are exported from contract.ts