/**
 * Error Handling Framework Tests
 * Requirements: 3.5, 8.1, 8.2, 8.4, 8.5, 9.5
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ComprehensiveErrorHandler,
  DefaultErrorReporter,
  DefaultGracefulDegradation,
  createBlueprintError,
  createContractError,
  createRuntimeError,
  createRepositoryError,
  retryWithBackoff,
  globalErrorHandler,
  globalErrorReporter,
  globalGracefulDegradation
} from '../error-handling';
import { 
  ErrorRecovery,
  RetryOptions
} from '../../interfaces/error-handling';

describe('Error Handling Framework', () => {
  let errorHandler: ComprehensiveErrorHandler;
  let errorReporter: DefaultErrorReporter;
  let gracefulDegradation: DefaultGracefulDegradation;

  beforeEach(() => {
    errorReporter = new DefaultErrorReporter();
    gracefulDegradation = new DefaultGracefulDegradation();
    errorHandler = new ComprehensiveErrorHandler(errorReporter, gracefulDegradation);
  });

  describe('Error Factory Functions', () => {
    it('should create blueprint errors correctly', () => {
      const error = createBlueprintError('parsing', 'Invalid blueprint', 'BP001', { detail: 'test' });
      
      expect(error.type).toBe('parsing');
      expect(error.code).toBe('BP001');
      expect(error.message).toBe('Invalid blueprint');
      expect(error.details).toEqual({ detail: 'test' });
    });

    it('should create contract errors correctly', () => {
      const error = createContractError('validation', 'Invalid contract', 'CT001', '/path/to/contract', { detail: 'test' });
      
      expect(error.type).toBe('validation');
      expect(error.code).toBe('CT001');
      expect(error.path).toBe('/path/to/contract');
      expect(error.message).toBe('Invalid contract');
      expect(error.details).toEqual({ detail: 'test' });
    });

    it('should create runtime errors correctly', () => {
      const error = createRuntimeError('rendering', 'Render failed', 'RT001', 'comp1', 'op1', { detail: 'test' });
      
      expect(error.type).toBe('rendering');
      expect(error.code).toBe('RT001');
      expect(error.componentId).toBe('comp1');
      expect(error.operationId).toBe('op1');
      expect(error.message).toBe('Render failed');
      expect(error.details).toEqual({ detail: 'test' });
    });

    it('should create repository errors correctly', () => {
      const error = createRepositoryError('not-found', 'Component not found', 'RP001', 'comp1', { detail: 'test' });
      
      expect(error.type).toBe('not-found');
      expect(error.code).toBe('RP001');
      expect(error.componentId).toBe('comp1');
      expect(error.message).toBe('Component not found');
      expect(error.details).toEqual({ detail: 'test' });
    });
  });

  describe('Blueprint Error Handling', () => {
    it('should handle parsing errors with user-input strategy', () => {
      const error = createBlueprintError('parsing', 'Cannot parse blueprint', 'BP001');
      const recovery = errorHandler.handleBlueprintError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('Unable to parse');
      expect(recovery.suggestedActions).toContain('Simplify your description');
    });

    it('should handle validation errors with user-input strategy', () => {
      const error = createBlueprintError('validation', 'Blueprint validation failed', 'BP002');
      const recovery = errorHandler.handleBlueprintError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('validation failed');
      expect(recovery.suggestedActions).toContain('Review conflicting requirements');
    });

    it('should handle ambiguity errors with user-input strategy', () => {
      const error = createBlueprintError('ambiguity', 'Blueprint is ambiguous', 'BP003');
      const recovery = errorHandler.handleBlueprintError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('ambiguous');
      expect(recovery.suggestedActions).toContain('Provide more specific details');
    });

    it('should handle generation errors with retry strategy', () => {
      const error = createBlueprintError('generation', 'Generation failed', 'BP004');
      const recovery = errorHandler.handleBlueprintError(error);

      expect(recovery.strategy).toBe('retry');
      expect(recovery.message).toContain('Failed to generate');
      expect(recovery.retryOptions).toBeDefined();
      expect(recovery.retryOptions?.maxAttempts).toBe(3);
      expect(recovery.retryOptions?.backoffStrategy).toBe('exponential');
    });
  });

  describe('Contract Error Handling', () => {
    it('should handle validation errors with user-input strategy', () => {
      const error = createContractError('validation', 'Contract validation failed', 'CT001');
      const recovery = errorHandler.handleContractError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('validation failed');
      expect(recovery.suggestedActions).toContain('Review the contract structure');
    });

    it('should handle resolution errors with fallback strategy', () => {
      const error = createContractError('resolution', 'Component resolution failed', 'CT002');
      const recovery = errorHandler.handleContractError(error);

      expect(recovery.strategy).toBe('fallback');
      expect(recovery.message).toContain('Unable to resolve');
      expect(recovery.fallbackContract).toBeDefined();
      expect(recovery.fallbackContract?.name).toBe('Fallback Contract');
    });

    it('should handle dependency errors with user-input strategy', () => {
      const error = createContractError('dependency', 'Dependency conflict', 'CT003');
      const recovery = errorHandler.handleContractError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('dependency conflicts');
      expect(recovery.suggestedActions).toContain('Resolve dependency conflicts');
    });

    it('should handle generation errors with retry strategy', () => {
      const error = createContractError('generation', 'Generation failed', 'CT004');
      const recovery = errorHandler.handleContractError(error);

      expect(recovery.strategy).toBe('retry');
      expect(recovery.message).toContain('generation failed');
      expect(recovery.retryOptions?.maxAttempts).toBe(2);
      expect(recovery.retryOptions?.backoffStrategy).toBe('linear');
    });
  });

  describe('Runtime Error Handling', () => {
    it('should handle rendering errors with graceful-degradation strategy', () => {
      const error = createRuntimeError('rendering', 'Render failed', 'RT001', 'comp1');
      const recovery = errorHandler.handleRuntimeError(error);

      expect(recovery.strategy).toBe('graceful-degradation');
      expect(recovery.message).toContain('rendering failed');
      expect(recovery.suggestedActions).toContain('Refresh the experience');
    });

    it('should handle operation errors with graceful-degradation strategy', () => {
      const error = createRuntimeError('operation', 'Operation failed', 'RT002', undefined, 'op1');
      const recovery = errorHandler.handleRuntimeError(error);

      expect(recovery.strategy).toBe('graceful-degradation');
      expect(recovery.message).toContain('execution failed');
      expect(recovery.suggestedActions).toContain('Retry the operation');
    });

    it('should handle state errors with retry strategy', () => {
      const error = createRuntimeError('state', 'State error', 'RT003');
      const recovery = errorHandler.handleRuntimeError(error);

      expect(recovery.strategy).toBe('retry');
      expect(recovery.message).toContain('State management error');
      expect(recovery.retryOptions?.maxAttempts).toBe(1);
    });

    it('should handle component errors with graceful-degradation strategy', () => {
      const error = createRuntimeError('component', 'Component error', 'RT004', 'comp1');
      const recovery = errorHandler.handleRuntimeError(error);

      expect(recovery.strategy).toBe('graceful-degradation');
      expect(recovery.message).toContain('Component error');
      expect(recovery.suggestedActions).toContain('Update the component');
    });
  });

  describe('Repository Error Handling', () => {
    it('should handle not-found errors with fallback strategy', () => {
      const error = createRepositoryError('not-found', 'Component not found', 'RP001', 'comp1');
      const recovery = errorHandler.handleRepositoryError(error);

      expect(recovery.strategy).toBe('fallback');
      expect(recovery.message).toContain('not found');
      expect(recovery.fallbackContract).toBeDefined();
      expect(recovery.suggestedActions).toContain('Install the missing component');
    });

    it('should handle validation errors with user-input strategy', () => {
      const error = createRepositoryError('validation', 'Manifest validation failed', 'RP002');
      const recovery = errorHandler.handleRepositoryError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('validation failed');
      expect(recovery.suggestedActions).toContain('Fix component manifest errors');
    });

    it('should handle dependency errors with user-input strategy', () => {
      const error = createRepositoryError('dependency', 'Dependency issues', 'RP003');
      const recovery = errorHandler.handleRepositoryError(error);

      expect(recovery.strategy).toBe('user-input');
      expect(recovery.message).toContain('dependency issues');
      expect(recovery.suggestedActions).toContain('Install missing dependencies');
    });

    it('should handle storage errors with retry strategy', () => {
      const error = createRepositoryError('storage', 'Storage error', 'RP004');
      const recovery = errorHandler.handleRepositoryError(error);

      expect(recovery.strategy).toBe('retry');
      expect(recovery.message).toContain('storage error');
      expect(recovery.retryOptions?.maxAttempts).toBe(2);
    });
  });

  describe('Error Reporter', () => {
    it('should report errors and maintain history', () => {
      const error = new Error('Test error');
      const context = { timestamp: new Date(), userAction: 'test' };

      errorReporter.reportError(error, context);
      
      const history = errorReporter.getErrorHistory();
      expect(history).toHaveLength(1);
      expect(history[0].error).toBe(error);
      expect(history[0].context).toBe(context);
      expect(history[0].resolved).toBe(false);
    });

    it('should limit error history size', () => {
      // Add more than 100 errors
      for (let i = 0; i < 105; i++) {
        errorReporter.reportError(new Error(`Error ${i}`));
      }

      const history = errorReporter.getErrorHistory();
      expect(history).toHaveLength(100);
      expect(history[0].error.message).toBe('Error 104'); // Most recent
    });

    it('should clear error history', () => {
      errorReporter.reportError(new Error('Test error'));
      expect(errorReporter.getErrorHistory()).toHaveLength(1);

      errorReporter.clearErrorHistory();
      expect(errorReporter.getErrorHistory()).toHaveLength(0);
    });

    it('should mark errors as resolved', () => {
      const error = new Error('Test error');
      const recovery: ErrorRecovery = {
        strategy: 'retry',
        message: 'Retry the operation',
        suggestedActions: ['Try again']
      };

      errorReporter.reportError(error);
      errorReporter.markErrorResolved(0, recovery);

      const history = errorReporter.getErrorHistory();
      expect(history[0].resolved).toBe(true);
      expect(history[0].recovery).toBe(recovery);
    });
  });

  describe('Graceful Degradation', () => {
    it('should handle missing components', () => {
      const FallbackComponent = gracefulDegradation.handleMissingComponent('test-component');
      expect(FallbackComponent).toBeDefined();
      expect(typeof FallbackComponent).toBe('function');
    });

    it('should handle operation failures', () => {
      const error = new Error('Operation failed');
      const result = gracefulDegradation.handleOperationFailure('test-op', error);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Operation failed');
      expect(result.fallbackData).toBe(null);
    });

    it('should handle rendering failures', () => {
      const error = new Error('Render failed');
      const FallbackComponent = gracefulDegradation.handleRenderingFailure('test-element', error);
      
      expect(FallbackComponent).toBeDefined();
      expect(typeof FallbackComponent).toBe('function');
    });
  });

  describe('Retry with Backoff', () => {
    it('should succeed on first attempt', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const options: RetryOptions = {
        maxAttempts: 3,
        backoffStrategy: 'linear',
        baseDelay: 100
      };

      const result = await retryWithBackoff(operation, options);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');
      
      const options: RetryOptions = {
        maxAttempts: 3,
        backoffStrategy: 'linear',
        baseDelay: 10
      };

      const result = await retryWithBackoff(operation, options);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should fail after max attempts', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Always fails'));
      const options: RetryOptions = {
        maxAttempts: 2,
        backoffStrategy: 'exponential',
        baseDelay: 10
      };

      await expect(retryWithBackoff(operation, options)).rejects.toThrow('Always fails');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should use exponential backoff strategy', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');
      
      const options: RetryOptions = {
        maxAttempts: 3,
        backoffStrategy: 'exponential',
        baseDelay: 10
      };

      const startTime = Date.now();
      await retryWithBackoff(operation, options);
      const endTime = Date.now();
      
      // Should have waited at least 10ms + 20ms = 30ms for exponential backoff
      expect(endTime - startTime).toBeGreaterThanOrEqual(25);
    });
  });

  describe('Global Error Handler', () => {
    it('should be properly initialized', () => {
      expect(globalErrorHandler).toBeDefined();
      expect(globalErrorReporter).toBeDefined();
      expect(globalGracefulDegradation).toBeDefined();
    });

    it('should handle errors through global instance', () => {
      const error = createBlueprintError('parsing', 'Test error', 'TEST001');
      const recovery = globalErrorHandler.handleBlueprintError(error);
      
      expect(recovery).toBeDefined();
      expect(recovery.strategy).toBe('user-input');
    });
  });
});
