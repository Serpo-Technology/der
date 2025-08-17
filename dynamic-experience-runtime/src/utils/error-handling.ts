/**
 * Error Handling Framework - Comprehensive error management implementation
 * Requirements: 3.5, 8.1, 8.2, 8.4, 8.5, 9.5
 */

import { 
  ErrorHandler, 
  ErrorRecovery, 
  BlueprintError, 
  ContractError, 
  RuntimeError, 
  RepositoryError,
  ErrorReporter,
  ErrorContext,
  ErrorReport,
  GracefulDegradation,
  RetryOptions
} from '../interfaces/error-handling';
import { Contract } from '../types/contract';
import React from 'react';

/**
 * Comprehensive Error Handler Implementation
 */
export class ComprehensiveErrorHandler implements ErrorHandler {
  private errorReporter: ErrorReporter;

  constructor(errorReporter: ErrorReporter, _gracefulDegradation: GracefulDegradation) {
    this.errorReporter = errorReporter;
  }

  handleBlueprintError(error: BlueprintError): ErrorRecovery {
    const context: ErrorContext = {
      userAction: 'blueprint-processing',
      timestamp: new Date()
    };
    
    this.errorReporter.reportError(error, context);

    switch (error.type) {
      case 'parsing':
        return {
          strategy: 'user-input',
          message: 'Unable to parse the blueprint description. Please provide clearer instructions.',
          suggestedActions: [
            'Simplify your description',
            'Add more specific details',
            'Use examples to clarify intent',
            'Break down complex requirements into smaller parts'
          ]
        };

      case 'validation':
        return {
          strategy: 'user-input',
          message: 'Blueprint validation failed. Some requirements are conflicting or invalid.',
          suggestedActions: [
            'Review conflicting requirements',
            'Ensure all constraints are achievable',
            'Check for missing required information'
          ]
        };

      case 'ambiguity':
        return {
          strategy: 'user-input',
          message: 'Blueprint description is ambiguous. Multiple interpretations are possible.',
          suggestedActions: [
            'Provide more specific details',
            'Choose from suggested interpretations',
            'Add examples of expected behavior',
            'Clarify unclear requirements'
          ]
        };

      case 'generation':
        return {
          strategy: 'retry',
          message: 'Failed to generate blueprint from description. This might be a temporary issue.',
          suggestedActions: [
            'Try again with the same description',
            'Simplify the requirements',
            'Check your internet connection'
          ],
          retryOptions: {
            maxAttempts: 3,
            backoffStrategy: 'exponential',
            baseDelay: 1000
          }
        };

      default:
        return this.getDefaultRecovery('blueprint', error);
    }
  }

  handleContractError(error: ContractError): ErrorRecovery {
    const context: ErrorContext = {
      contractId: error.path,
      userAction: 'contract-processing',
      timestamp: new Date()
    };
    
    this.errorReporter.reportError(error, context);

    switch (error.type) {
      case 'validation':
        return {
          strategy: 'user-input',
          message: 'Contract validation failed. The generated contract has structural issues.',
          suggestedActions: [
            'Review the contract structure',
            'Fix validation errors manually',
            'Regenerate the contract with simpler requirements',
            'Check component dependencies'
          ]
        };

      case 'resolution':
        return {
          strategy: 'fallback',
          message: 'Unable to resolve required components for the contract.',
          suggestedActions: [
            'Install missing components',
            'Use alternative components',
            'Simplify the requirements',
            'Check component repository connection'
          ],
          fallbackContract: this.createMinimalContract()
        };

      case 'dependency':
        return {
          strategy: 'user-input',
          message: 'Component dependency conflicts detected in the contract.',
          suggestedActions: [
            'Resolve dependency conflicts',
            'Update component versions',
            'Remove conflicting components',
            'Use compatible component alternatives'
          ]
        };

      case 'generation':
        return {
          strategy: 'retry',
          message: 'Contract generation failed. This might be a temporary processing issue.',
          suggestedActions: [
            'Retry contract generation',
            'Simplify the blueprint',
            'Check component repository status'
          ],
          retryOptions: {
            maxAttempts: 2,
            backoffStrategy: 'linear',
            baseDelay: 2000
          }
        };

      default:
        return this.getDefaultRecovery('contract', error);
    }
  }

  handleRuntimeError(error: RuntimeError): ErrorRecovery {
    const context: ErrorContext = {
      componentId: error.componentId,
      operationId: error.operationId,
      userAction: 'runtime-execution',
      timestamp: new Date()
    };
    
    this.errorReporter.reportError(error, context);

    switch (error.type) {
      case 'rendering':
        return {
          strategy: 'graceful-degradation',
          message: 'Component rendering failed. Showing fallback UI.',
          suggestedActions: [
            'Refresh the experience',
            'Check component implementation',
            'Report the issue if it persists',
            'Try a different component'
          ]
        };

      case 'operation':
        return {
          strategy: 'graceful-degradation',
          message: 'Operation execution failed. Some functionality may be limited.',
          suggestedActions: [
            'Retry the operation',
            'Check network connection',
            'Verify operation parameters',
            'Use alternative operations'
          ]
        };

      case 'state':
        return {
          strategy: 'retry',
          message: 'State management error occurred. Attempting to recover.',
          suggestedActions: [
            'Refresh the experience',
            'Reset to initial state',
            'Save current work before continuing'
          ],
          retryOptions: {
            maxAttempts: 1,
            backoffStrategy: 'linear',
            baseDelay: 500
          }
        };

      case 'component':
        return {
          strategy: 'graceful-degradation',
          message: 'Component error detected. Using fallback component.',
          suggestedActions: [
            'Update the component',
            'Check component compatibility',
            'Report component issues',
            'Use alternative components'
          ]
        };

      default:
        return this.getDefaultRecovery('runtime', error);
    }
  }

  handleRepositoryError(error: RepositoryError): ErrorRecovery {
    const context: ErrorContext = {
      componentId: error.componentId,
      userAction: 'repository-access',
      timestamp: new Date()
    };
    
    this.errorReporter.reportError(error, context);

    switch (error.type) {
      case 'not-found':
        return {
          strategy: 'fallback',
          message: 'Required component not found in repository.',
          suggestedActions: [
            'Install the missing component',
            'Use an alternative component',
            'Check component name spelling',
            'Update component repository'
          ],
          fallbackContract: this.createMinimalContract()
        };

      case 'validation':
        return {
          strategy: 'user-input',
          message: 'Component manifest validation failed.',
          suggestedActions: [
            'Fix component manifest errors',
            'Update component version',
            'Contact component author',
            'Use a different component'
          ]
        };

      case 'dependency':
        return {
          strategy: 'user-input',
          message: 'Component dependency issues detected.',
          suggestedActions: [
            'Install missing dependencies',
            'Update dependency versions',
            'Resolve version conflicts',
            'Use components with fewer dependencies'
          ]
        };

      case 'storage':
        return {
          strategy: 'retry',
          message: 'Repository storage error. Unable to access component data.',
          suggestedActions: [
            'Check disk space',
            'Verify file permissions',
            'Restart the application',
            'Clear repository cache'
          ],
          retryOptions: {
            maxAttempts: 2,
            backoffStrategy: 'linear',
            baseDelay: 1000
          }
        };

      default:
        return this.getDefaultRecovery('repository', error);
    }
  }

  private getDefaultRecovery(category: string, error: Error): ErrorRecovery {
    return {
      strategy: 'user-input',
      message: `An unexpected ${category} error occurred: ${error.message}`,
      suggestedActions: [
        'Try the operation again',
        'Restart the application',
        'Check for updates',
        'Report this issue'
      ]
    };
  }

  private createMinimalContract(): Contract {
    return {
      name: 'Fallback Contract',
      version: '1.0.0',
      elements: [{
        id: 'fallback-message',
        type: 'text',
        properties: {
          content: 'Some components are unavailable. Basic functionality is provided.'
        },
        dataBindings: [],
        eventBindings: []
      }],
      operations: [],
      layout: {
        type: 'flex',
        properties: { spacing: 'medium' }
      },
      styling: {
        theme: 'default'
      },
      metadata: {
        description: 'Fallback contract for error recovery',
        tags: ['fallback', 'error-recovery'],
        author: 'System',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0'
      }
    };
  }
}

/**
 * Error Reporter Implementation
 */
export class DefaultErrorReporter implements ErrorReporter {
  private errorHistory: ErrorReport[] = [];
  private maxHistorySize = 100;

  reportError(error: Error, context?: ErrorContext): void {
    const report: ErrorReport = {
      error,
      context: context || { timestamp: new Date() },
      resolved: false,
      timestamp: new Date()
    };

    this.errorHistory.unshift(report);
    
    // Maintain history size limit
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory = this.errorHistory.slice(0, this.maxHistorySize);
    }

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.group(`🚨 Error Report - ${error.constructor.name}`);
      console.error('Error:', error);
      console.log('Context:', context);
      console.log('Timestamp:', report.timestamp);
      console.groupEnd();
    }
  }

  getErrorHistory(): ErrorReport[] {
    return [...this.errorHistory];
  }

  clearErrorHistory(): void {
    this.errorHistory = [];
  }

  markErrorResolved(errorIndex: number, recovery?: ErrorRecovery): void {
    if (errorIndex >= 0 && errorIndex < this.errorHistory.length) {
      this.errorHistory[errorIndex].resolved = true;
      this.errorHistory[errorIndex].recovery = recovery;
    }
  }
}

/**
 * Graceful Degradation Implementation
 */
export class DefaultGracefulDegradation implements GracefulDegradation {
  handleMissingComponent(componentId: string): React.ComponentType {
    return () => React.createElement('div', {
      className: 'error-placeholder',
      style: {
        padding: '16px',
        border: '2px dashed #ccc',
        borderRadius: '4px',
        textAlign: 'center',
        color: '#666',
        backgroundColor: '#f9f9f9'
      }
    }, `Component "${componentId}" is not available`);
  }

  handleOperationFailure(operationId: string, error: Error): any {
    console.warn(`Operation ${operationId} failed:`, error);
    return {
      success: false,
      error: error.message,
      fallbackData: null
    };
  }

  handleRenderingFailure(elementId: string, error: Error): React.ComponentType {
    return () => React.createElement('div', {
      className: 'rendering-error',
      style: {
        padding: '12px',
        border: '1px solid #ff6b6b',
        borderRadius: '4px',
        backgroundColor: '#ffe0e0',
        color: '#d63031'
      }
    }, `Rendering failed for element "${elementId}": ${error.message}`);
  }
}

/**
 * Error Factory Functions
 */
export function createBlueprintError(
  type: BlueprintError['type'],
  message: string,
  code: string,
  details?: any
): BlueprintError {
  const error = new Error(message) as BlueprintError;
  error.type = type;
  error.code = code;
  error.details = details;
  return error;
}

export function createContractError(
  type: ContractError['type'],
  message: string,
  code: string,
  path?: string,
  details?: any
): ContractError {
  const error = new Error(message) as ContractError;
  error.type = type;
  error.code = code;
  error.path = path;
  error.details = details;
  return error;
}

export function createRuntimeError(
  type: RuntimeError['type'],
  message: string,
  code: string,
  componentId?: string,
  operationId?: string,
  details?: any
): RuntimeError {
  const error = new Error(message) as RuntimeError;
  error.type = type;
  error.code = code;
  error.componentId = componentId;
  error.operationId = operationId;
  error.details = details;
  return error;
}

export function createRepositoryError(
  type: RepositoryError['type'],
  message: string,
  code: string,
  componentId?: string,
  details?: any
): RepositoryError {
  const error = new Error(message) as RepositoryError;
  error.type = type;
  error.code = code;
  error.componentId = componentId;
  error.details = details;
  return error;
}

/**
 * Retry Utility Function
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === options.maxAttempts) {
        throw lastError;
      }
      
      const delay = options.backoffStrategy === 'exponential'
        ? options.baseDelay * Math.pow(2, attempt - 1)
        : options.baseDelay * attempt;
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

/**
 * Global Error Handler Instance
 */
export const globalErrorReporter = new DefaultErrorReporter();
export const globalGracefulDegradation = new DefaultGracefulDegradation();
export const globalErrorHandler = new ComprehensiveErrorHandler(
  globalErrorReporter,
  globalGracefulDegradation
);
