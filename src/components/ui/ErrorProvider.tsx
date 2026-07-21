/**
 * Error Provider - Global error management context
 * Requirements: 3.5, 8.2, 8.5, 9.5
 */

import React, { createContext, useContext, useReducer, useCallback, ReactNode } from 'react';
import { 
  ErrorReport, 
  ErrorRecovery, 
  ErrorContext as ErrorContextType 
} from '../../interfaces/error-handling';
import { 
  globalErrorHandler, 
  globalErrorReporter, 
  retryWithBackoff 
} from '../../utils/error-handling';
import { ErrorBanner } from './ErrorDisplay';

interface ErrorState {
  activeErrors: ErrorReport[];
  errorHistory: ErrorReport[];
  showBanners: boolean;
  maxActiveErrors: number;
}

type ErrorAction = 
  | { type: 'ADD_ERROR'; payload: { error: Error; context?: ErrorContextType; recovery?: ErrorRecovery } }
  | { type: 'RESOLVE_ERROR'; payload: { errorId: string; recovery?: ErrorRecovery } }
  | { type: 'DISMISS_ERROR'; payload: { errorId: string } }
  | { type: 'CLEAR_ERRORS' }
  | { type: 'TOGGLE_BANNERS' }
  | { type: 'SET_MAX_ACTIVE_ERRORS'; payload: number };

interface ErrorContextValue {
  state: ErrorState;
  addError: (error: Error, context?: ErrorContextType, recovery?: ErrorRecovery) => string;
  resolveError: (errorId: string, recovery?: ErrorRecovery) => void;
  dismissError: (errorId: string) => void;
  clearErrors: () => void;
  retryError: (errorId: string) => Promise<void>;
  toggleBanners: () => void;
  setMaxActiveErrors: (max: number) => void;
}

const ErrorContext = createContext<ErrorContextValue | null>(null);

function errorReducer(state: ErrorState, action: ErrorAction): ErrorState {
  switch (action.type) {
    case 'ADD_ERROR': {
      const errorReport: ErrorReport = {
        error: action.payload.error,
        context: action.payload.context || { timestamp: new Date() },
        recovery: action.payload.recovery,
        resolved: false,
        timestamp: new Date()
      };

      // Add to global error reporter
      globalErrorReporter.reportError(action.payload.error, action.payload.context);

      const newActiveErrors = [...state.activeErrors, errorReport];
      
      // Limit active errors
      if (newActiveErrors.length > state.maxActiveErrors) {
        newActiveErrors.shift();
      }

      return {
        ...state,
        activeErrors: newActiveErrors,
        errorHistory: [errorReport, ...state.errorHistory].slice(0, 100) // Keep last 100 errors
      };
    }

    case 'RESOLVE_ERROR': {
      const updatedActiveErrors = state.activeErrors.map(error => 
        error.error.message === action.payload.errorId 
          ? { ...error, resolved: true, recovery: action.payload.recovery }
          : error
      );

      const updatedHistory = state.errorHistory.map(error => 
        error.error.message === action.payload.errorId 
          ? { ...error, resolved: true, recovery: action.payload.recovery }
          : error
      );

      return {
        ...state,
        activeErrors: updatedActiveErrors.filter(error => !error.resolved),
        errorHistory: updatedHistory
      };
    }

    case 'DISMISS_ERROR': {
      return {
        ...state,
        activeErrors: state.activeErrors.filter(error => error.error.message !== action.payload.errorId)
      };
    }

    case 'CLEAR_ERRORS': {
      globalErrorReporter.clearErrorHistory();
      return {
        ...state,
        activeErrors: [],
        errorHistory: []
      };
    }

    case 'TOGGLE_BANNERS': {
      return {
        ...state,
        showBanners: !state.showBanners
      };
    }

    case 'SET_MAX_ACTIVE_ERRORS': {
      const newActiveErrors = state.activeErrors.slice(-action.payload);
      return {
        ...state,
        maxActiveErrors: action.payload,
        activeErrors: newActiveErrors
      };
    }

    default:
      return state;
  }
}

interface ErrorProviderProps {
  children: ReactNode;
  maxActiveErrors?: number;
  showBanners?: boolean;
}

export const ErrorProvider: React.FC<ErrorProviderProps> = ({ 
  children, 
  maxActiveErrors = 5,
  showBanners = true 
}) => {
  const [state, dispatch] = useReducer(errorReducer, {
    activeErrors: [],
    errorHistory: [],
    showBanners,
    maxActiveErrors
  });

  const addError = useCallback((
    error: Error, 
    context?: ErrorContextType, 
    recovery?: ErrorRecovery
  ): string => {
    // If no recovery provided, get it from the global error handler
    let errorRecovery = recovery;
    if (!errorRecovery) {
      if (error.name === 'BlueprintError') {
        errorRecovery = globalErrorHandler.handleBlueprintError(error as any);
      } else if (error.name === 'ContractError') {
        errorRecovery = globalErrorHandler.handleContractError(error as any);
      } else if (error.name === 'RuntimeError') {
        errorRecovery = globalErrorHandler.handleRuntimeError(error as any);
      } else if (error.name === 'RepositoryError') {
        errorRecovery = globalErrorHandler.handleRepositoryError(error as any);
      }
    }

    dispatch({ 
      type: 'ADD_ERROR', 
      payload: { error, context, recovery: errorRecovery } 
    });
    
    return error.message;
  }, []);

  const resolveError = useCallback((errorId: string, recovery?: ErrorRecovery) => {
    dispatch({ type: 'RESOLVE_ERROR', payload: { errorId, recovery } });
  }, []);

  const dismissError = useCallback((errorId: string) => {
    dispatch({ type: 'DISMISS_ERROR', payload: { errorId } });
  }, []);

  const clearErrors = useCallback(() => {
    dispatch({ type: 'CLEAR_ERRORS' });
  }, []);

  const retryError = useCallback(async (errorId: string) => {
    const errorReport = state.activeErrors.find(e => e.error.message === errorId);
    if (!errorReport || !errorReport.recovery?.retryOptions) {
      return;
    }

    try {
      // This is a placeholder - in a real implementation, you'd need to store
      // the original operation that failed and retry it
      await retryWithBackoff(
        async () => {
          // Simulate retry operation
          throw new Error('Retry not implemented for this error type');
        },
        errorReport.recovery.retryOptions
      );
      
      resolveError(errorId, errorReport.recovery);
    } catch (error) {
      // Retry failed, keep the error active
      console.warn('Retry failed for error:', errorId, error);
    }
  }, [state.activeErrors, resolveError]);

  const toggleBanners = useCallback(() => {
    dispatch({ type: 'TOGGLE_BANNERS' });
  }, []);

  const setMaxActiveErrors = useCallback((max: number) => {
    dispatch({ type: 'SET_MAX_ACTIVE_ERRORS', payload: max });
  }, []);

  const contextValue: ErrorContextValue = {
    state,
    addError,
    resolveError,
    dismissError,
    clearErrors,
    retryError,
    toggleBanners,
    setMaxActiveErrors
  };

  return (
    <ErrorContext.Provider value={contextValue}>
      {children}
      {state.showBanners && (
        <ErrorBanners 
          errors={state.activeErrors}
          onDismiss={dismissError}
          onRetry={retryError}
        />
      )}
    </ErrorContext.Provider>
  );
};

/**
 * Error Banners Component
 */
interface ErrorBannersProps {
  errors: ErrorReport[];
  onDismiss: (errorId: string) => void;
  onRetry: (errorId: string) => Promise<void>;
}

const ErrorBanners: React.FC<ErrorBannersProps> = ({ errors, onDismiss, onRetry }) => {
  if (errors.length === 0) return null;

  return (
    <div className="error-banners" style={{
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: 1000,
      maxWidth: '400px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    }}>
      {errors.slice(0, 3).map((errorReport, index) => (
        <ErrorBanner
          key={`${errorReport.error.message}-${index}`}
          error={errorReport.error}
          recovery={errorReport.recovery}
          onAction={errorReport.recovery?.strategy === 'retry' 
            ? () => onRetry(errorReport.error.message)
            : undefined
          }
          onDismiss={() => onDismiss(errorReport.error.message)}
        />
      ))}
      {errors.length > 3 && (
        <div style={{
          padding: '8px 12px',
          background: '#f8f9fa',
          border: '1px solid #dee2e6',
          borderRadius: '4px',
          fontSize: '12px',
          textAlign: 'center',
          color: '#6c757d'
        }}>
          +{errors.length - 3} more errors
        </div>
      )}
    </div>
  );
};

/**
 * Hook to use Error Context
 */
export function useErrorContext(): ErrorContextValue {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error('useErrorContext must be used within an ErrorProvider');
  }
  return context;
}

/**
 * Hook for simplified error handling
 */
export function useErrorHandler() {
  const { addError, resolveError } = useErrorContext();

  const handleError = useCallback((error: Error, context?: string) => {
    return addError(error, { 
      userAction: context || 'unknown',
      timestamp: new Date() 
    });
  }, [addError]);

  const handleAsyncError = useCallback(<T,>(
    operation: () => Promise<T>,
    context?: string
  ): Promise<T | null> => {
    return (async () => {
      try {
        return await operation();
      } catch (error) {
        handleError(error as Error, context);
        return null;
      }
    })();
  }, [handleError]);

  return { handleError, handleAsyncError, resolveError };
}

/**
 * Hook for error recovery actions
 */
export function useErrorRecovery() {
  const { retryError, resolveError, dismissError } = useErrorContext();

  const recoverFromError = useCallback(async (
    errorId: string,
    recoveryAction?: () => Promise<void>
  ) => {
    if (recoveryAction) {
      try {
        await recoveryAction();
        resolveError(errorId);
      } catch (error) {
        console.warn('Recovery action failed:', error);
      }
    } else {
      await retryError(errorId);
    }
  }, [retryError, resolveError]);

  return { recoverFromError, dismissError };
}
