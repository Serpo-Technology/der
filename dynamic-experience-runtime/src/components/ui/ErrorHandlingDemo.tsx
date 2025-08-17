/**
 * Error Handling Demo Component - Demonstrates comprehensive error handling
 * Requirements: 3.5, 8.1, 8.2, 8.4, 8.5, 9.5
 */

import React, { useState } from 'react';
import { 
  ErrorProvider, 
  ErrorBoundary, 
  ErrorDisplay, 
  ErrorHistory, 
  useErrorHandler, 
  useErrorContext 
} from './index';
import { 
  createBlueprintError, 
  createContractError, 
  createRuntimeError, 
  createRepositoryError,
  globalErrorHandler
} from '../../utils/error-handling';

/**
 * Demo Component with Error Triggers
 */
const ErrorTriggerDemo: React.FC = () => {
  const { handleError } = useErrorHandler();
  const { state, clearErrors } = useErrorContext();
  const [showHistory, setShowHistory] = useState(false);

  const triggerBlueprintError = () => {
    const error = createBlueprintError(
      'parsing',
      'Unable to parse the blueprint description. The input contains ambiguous requirements.',
      'BP001',
      { 
        input: 'Create a dashboard with buttons and stuff',
        suggestions: ['Be more specific about button types', 'Define dashboard layout']
      }
    );
    handleError(error, 'blueprint-parsing');
  };

  const triggerContractError = () => {
    const error = createContractError(
      'resolution',
      'Cannot resolve required components for the contract.',
      'CT002',
      '/contracts/dashboard.json',
      { 
        missingComponents: ['advanced-chart', 'data-grid'],
        availableAlternatives: ['simple-chart', 'basic-table']
      }
    );
    handleError(error, 'contract-generation');
  };

  const triggerRuntimeError = () => {
    const error = createRuntimeError(
      'rendering',
      'Component rendering failed due to invalid props.',
      'RT001',
      'dashboard-widget',
      'render-operation',
      { 
        invalidProps: ['data', 'config'],
        expectedTypes: { data: 'array', config: 'object' }
      }
    );
    handleError(error, 'component-rendering');
  };

  const triggerRepositoryError = () => {
    const error = createRepositoryError(
      'not-found',
      'Component "advanced-analytics" not found in repository.',
      'RP001',
      'advanced-analytics',
      { 
        searchedPaths: ['/components', '/custom-components'],
        suggestions: ['basic-analytics', 'simple-charts']
      }
    );
    handleError(error, 'component-lookup');
  };

  const triggerRenderError = () => {
    throw new Error('Intentional render error for testing error boundary');
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h2>Error Handling System Demo</h2>
      
      <div style={{ marginBottom: '20px' }}>
        <h3>Trigger Different Error Types</h3>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <button onClick={triggerBlueprintError}>
            Blueprint Error
          </button>
          <button onClick={triggerContractError}>
            Contract Error
          </button>
          <button onClick={triggerRuntimeError}>
            Runtime Error
          </button>
          <button onClick={triggerRepositoryError}>
            Repository Error
          </button>
          <button onClick={triggerRenderError} style={{ backgroundColor: '#ff6b6b' }}>
            Render Error (Boundary)
          </button>
        </div>
        
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <button onClick={clearErrors}>
            Clear All Errors
          </button>
          <button onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide' : 'Show'} Error History
          </button>
        </div>
      </div>

      {state.activeErrors.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3>Active Errors ({state.activeErrors.length})</h3>
          {state.activeErrors.map((errorReport, index) => (
            <ErrorDisplay
              key={index}
              error={errorReport.error}
              recovery={errorReport.recovery}
              onRetry={() => console.log('Retry clicked for:', errorReport.error.message)}
              onDismiss={() => console.log('Dismiss clicked for:', errorReport.error.message)}
              onReportIssue={(error) => console.log('Report issue for:', error.message)}
              showDetails={false}
            />
          ))}
        </div>
      )}

      {showHistory && (
        <div style={{ marginBottom: '20px' }}>
          <ErrorHistory
            errors={state.errorHistory}
            onClearHistory={clearErrors}
            onRetryError={(index) => console.log('Retry error at index:', index)}
          />
        </div>
      )}

      <div style={{ marginBottom: '20px' }}>
        <h3>Error Recovery Strategies</h3>
        <div style={{ 
          background: '#f8f9fa', 
          padding: '15px', 
          borderRadius: '5px',
          fontSize: '14px'
        }}>
          <p><strong>Blueprint Errors:</strong> User input required to clarify requirements</p>
          <p><strong>Contract Errors:</strong> Fallback contracts or user intervention</p>
          <p><strong>Runtime Errors:</strong> Graceful degradation with fallback UI</p>
          <p><strong>Repository Errors:</strong> Alternative components or user action</p>
        </div>
      </div>

      <ErrorBoundaryDemo />
    </div>
  );
};

/**
 * Component that demonstrates Error Boundary
 */
const ErrorBoundaryDemo: React.FC = () => {
  const [shouldError, setShouldError] = useState(false);

  if (shouldError) {
    throw new Error('This is a test error from ErrorBoundaryDemo component');
  }

  return (
    <div style={{ 
      border: '1px solid #ddd', 
      padding: '15px', 
      borderRadius: '5px',
      marginTop: '20px'
    }}>
      <h4>Error Boundary Test Area</h4>
      <p>This component is wrapped in an Error Boundary.</p>
      <button 
        onClick={() => setShouldError(true)}
        style={{ backgroundColor: '#ff6b6b', color: 'white' }}
      >
        Trigger Component Error
      </button>
    </div>
  );
};

/**
 * Main Demo Component with Error Provider
 */
export const ErrorHandlingDemo: React.FC = () => {
  return (
    <ErrorProvider maxActiveErrors={5} showBanners={true}>
      <ErrorBoundary 
        enableRecovery={true}
        showErrorDetails={true}
        onError={(error, errorInfo) => {
          console.log('Error Boundary caught:', error, errorInfo);
        }}
      >
        <ErrorTriggerDemo />
      </ErrorBoundary>
    </ErrorProvider>
  );
};

/**
 * Async Error Handling Example
 */
export const AsyncErrorExample: React.FC = () => {
  const { handleAsyncError } = useErrorHandler();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const simulateAsyncOperation = async () => {
    setLoading(true);
    setResult(null);

    const result = await handleAsyncError(async () => {
      // Simulate an async operation that might fail
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (Math.random() > 0.5) {
        throw createRuntimeError(
          'operation',
          'Async operation failed randomly',
          'ASYNC001',
          undefined,
          'async-demo'
        );
      }
      
      return 'Operation completed successfully!';
    }, 'async-operation-demo');

    setLoading(false);
    setResult(result);
  };

  return (
    <div style={{ 
      border: '1px solid #ddd', 
      padding: '15px', 
      borderRadius: '5px',
      marginTop: '20px'
    }}>
      <h4>Async Error Handling Example</h4>
      <button 
        onClick={simulateAsyncOperation}
        disabled={loading}
      >
        {loading ? 'Running...' : 'Run Async Operation (50% fail rate)'}
      </button>
      {result && (
        <p style={{ color: 'green', marginTop: '10px' }}>{result}</p>
      )}
    </div>
  );
};

export default ErrorHandlingDemo;
