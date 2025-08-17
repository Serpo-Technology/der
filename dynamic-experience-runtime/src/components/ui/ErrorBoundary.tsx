/**
 * Error Boundary Component - React error boundary with recovery
 * Requirements: 3.5, 8.2, 8.5, 9.5
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ErrorDisplay } from './ErrorDisplay';
import { 
  createRuntimeError, 
  globalErrorHandler, 
  globalErrorReporter 
} from '../../utils/error-handling';
import { ErrorRecovery } from '../../interfaces/error-handling';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showErrorDetails?: boolean;
  enableRecovery?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  recovery: ErrorRecovery | undefined;
  retryCount: number;
}

/**
 * Error Boundary with Recovery Capabilities
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private maxRetries = 3;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      recovery: undefined,
      retryCount: 0
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Create a runtime error for the error handler
    const runtimeError = createRuntimeError(
      'rendering',
      `Component rendering failed: ${error.message}`,
      'RENDER_ERROR',
      undefined,
      undefined,
      { 
        originalError: error,
        componentStack: errorInfo.componentStack,
        errorBoundary: true
      }
    );

    // Get recovery strategy from error handler
    const recovery = globalErrorHandler.handleRuntimeError(runtimeError);

    this.setState({
      error: runtimeError,
      errorInfo,
      recovery: recovery,
      retryCount: 0
    });

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Log error for debugging
    console.group('🚨 Error Boundary Caught Error');
    console.error('Error:', error);
    console.error('Component Stack:', errorInfo.componentStack);
    console.groupEnd();
  }

  handleRetry = () => {
    if (this.state.retryCount < this.maxRetries) {
      this.setState(prevState => ({
        hasError: false,
        error: null,
        errorInfo: null,
        recovery: undefined,
        retryCount: prevState.retryCount + 1
      }));
    }
  };

  handleReportIssue = (error: Error) => {
    // Create issue report
    const report = {
      error: error.message,
      stack: error.stack,
      componentStack: this.state.errorInfo?.componentStack,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      retryCount: this.state.retryCount
    };

    // Log for now - in a real app, this would send to error reporting service
    console.log('Error Report:', report);
    
    // You could integrate with services like Sentry, LogRocket, etc.
    // Example: Sentry.captureException(error, { extra: report });
    
    alert('Error report logged to console. In a production app, this would be sent to an error reporting service.');
  };

  render() {
    if (this.state.hasError && this.state.error) {
      // If custom fallback is provided and recovery is not enabled, use it
      if (this.props.fallback && !this.props.enableRecovery) {
        return this.props.fallback;
      }

      // Show error display with recovery options
      return (
        <div className="error-boundary">
          <ErrorDisplay
            error={this.state.error}
            recovery={this.state.recovery}
            onRetry={this.props.enableRecovery && this.state.retryCount < this.maxRetries ? this.handleRetry : undefined}
            onReportIssue={this.handleReportIssue}
            showDetails={this.props.showErrorDetails}
          />
          
          {this.state.retryCount >= this.maxRetries && (
            <div className="error-boundary__max-retries">
              <p>Maximum retry attempts reached. Please refresh the page or contact support.</p>
              <button onClick={() => window.location.reload()}>
                Refresh Page
              </button>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Higher-Order Component for Error Boundary
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>
) {
  const WithErrorBoundaryComponent = (props: P) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  WithErrorBoundaryComponent.displayName = 
    `withErrorBoundary(${WrappedComponent.displayName || WrappedComponent.name})`;

  return WithErrorBoundaryComponent;
}

/**
 * Hook for Error Reporting
 */
export function useErrorReporting() {
  const reportError = React.useCallback((error: Error, context?: string) => {
    const runtimeError = createRuntimeError(
      'component',
      error.message,
      'HOOK_ERROR',
      undefined,
      undefined,
      { originalError: error, context, hook: true }
    );

    globalErrorReporter.reportError(runtimeError, {
      userAction: context || 'hook-execution',
      timestamp: new Date()
    });

    return globalErrorHandler.handleRuntimeError(runtimeError);
  }, []);

  return { reportError };
}

/**
 * Hook for Async Error Handling
 */
export function useAsyncError() {
  const [, setError] = React.useState();
  
  return React.useCallback((error: Error) => {
    setError(() => {
      throw error;
    });
  }, [setError]);
}

/**
 * Safe Component Wrapper
 */
interface SafeComponentProps {
  children: ReactNode;
  fallback?: ReactNode;
  componentName?: string;
}

export const SafeComponent: React.FC<SafeComponentProps> = ({ 
  children, 
  fallback, 
  componentName = 'Component' 
}) => {
  return (
    <ErrorBoundary
      fallback={fallback || <div>Error loading {componentName}</div>}
      enableRecovery={true}
      showErrorDetails={process.env.NODE_ENV === 'development'}
    >
      {children}
    </ErrorBoundary>
  );
};
