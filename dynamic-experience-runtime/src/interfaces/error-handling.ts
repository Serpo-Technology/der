/**
 * Error Handling interfaces - Comprehensive error management
 * Requirements: 3.5, 8.1, 8.2, 8.4, 8.5, 9.5
 */

export interface ErrorHandler {
  handleBlueprintError(error: BlueprintError): ErrorRecovery;
  handleContractError(error: ContractError): ErrorRecovery;
  handleRuntimeError(error: RuntimeError): ErrorRecovery;
  handleRepositoryError(error: RepositoryError): ErrorRecovery;
}

export interface ErrorRecovery {
  strategy: 'retry' | 'fallback' | 'user-input' | 'graceful-degradation';
  message: string;
  suggestedActions: string[];
  fallbackContract?: any;
  retryOptions?: RetryOptions;
}

export interface RetryOptions {
  maxAttempts: number;
  backoffStrategy: 'linear' | 'exponential';
  baseDelay: number;
}

export interface BlueprintError extends Error {
  type: 'parsing' | 'validation' | 'ambiguity' | 'generation';
  code: string;
  details?: any;
}

export interface ContractError extends Error {
  type: 'validation' | 'resolution' | 'dependency' | 'generation';
  code: string;
  path?: string;
  details?: any;
}

export interface RuntimeError extends Error {
  type: 'rendering' | 'operation' | 'state' | 'component';
  code: string;
  componentId?: string;
  operationId?: string;
  details?: any;
}

export interface RepositoryError extends Error {
  type: 'not-found' | 'validation' | 'dependency' | 'storage';
  code: string;
  componentId?: string;
  details?: any;
}

export interface ErrorReporter {
  reportError(error: Error, context?: ErrorContext): void;
  getErrorHistory(): ErrorReport[];
  clearErrorHistory(): void;
}

export interface ErrorContext {
  experienceId?: string;
  contractId?: string;
  componentId?: string;
  operationId?: string;
  userAction?: string;
  timestamp: Date;
}

export interface ErrorReport {
  error: Error;
  context: ErrorContext;
  recovery?: ErrorRecovery;
  resolved: boolean;
  timestamp: Date;
}

import React from 'react';

export interface GracefulDegradation {
  handleMissingComponent(componentId: string): React.ComponentType;
  handleOperationFailure(operationId: string, error: Error): any;
  handleRenderingFailure(elementId: string, error: Error): React.ComponentType;
}