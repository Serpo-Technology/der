/**
 * Error Display Components - User-friendly error reporting
 * Requirements: 3.5, 8.2, 8.5, 9.5
 */

import React, { useState, useCallback } from 'react';
import { 
  ErrorRecovery, 
  ErrorReport, 
  BlueprintError, 
  ContractError, 
  RuntimeError, 
  RepositoryError 
} from '../../interfaces/error-handling';
import './ErrorDisplay.css';

export interface ErrorDisplayProps {
  error: Error;
  recovery?: ErrorRecovery;
  onRetry?: () => void;
  onDismiss?: () => void;
  onReportIssue?: (error: Error) => void;
  showDetails?: boolean;
}

/**
 * Main Error Display Component
 */
export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error,
  recovery,
  onRetry,
  onDismiss,
  onReportIssue,
  showDetails = false
}) => {
  const [detailsExpanded, setDetailsExpanded] = useState(showDetails);
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    if (onRetry && !isRetrying) {
      setIsRetrying(true);
      try {
        await onRetry();
      } finally {
        setIsRetrying(false);
      }
    }
  }, [onRetry, isRetrying]);

  const getErrorIcon = (error: Error): string => {
    if (isBlueprintError(error)) {
      return '📝';
    } else if (isContractError(error)) {
      return '📋';
    } else if (isRuntimeError(error)) {
      return '⚡';
    } else if (isRepositoryError(error)) {
      return '📦';
    }
    return '❌';
  };

  const getErrorCategory = (error: Error): string => {
    if (isBlueprintError(error)) {
      return 'Blueprint';
    } else if (isContractError(error)) {
      return 'Contract';
    } else if (isRuntimeError(error)) {
      return 'Runtime';
    } else if (isRepositoryError(error)) {
      return 'Repository';
    }
    return 'System';
  };

  const getSeverityClass = (recovery?: ErrorRecovery): string => {
    if (!recovery) return 'error-display--critical';
    
    switch (recovery.strategy) {
      case 'graceful-degradation':
        return 'error-display--warning';
      case 'fallback':
        return 'error-display--warning';
      case 'retry':
        return 'error-display--info';
      case 'user-input':
        return 'error-display--attention';
      default:
        return 'error-display--critical';
    }
  };

  return (
    <div className={`error-display ${getSeverityClass(recovery)}`}>
      <div className="error-display__header">
        <div className="error-display__icon">
          {getErrorIcon(error)}
        </div>
        <div className="error-display__title">
          <span className="error-display__category">{getErrorCategory(error)} Error</span>
          <h3 className="error-display__message">
            {recovery?.message || error.message}
          </h3>
        </div>
        <div className="error-display__actions">
          {onDismiss && (
            <button 
              className="error-display__dismiss"
              onClick={onDismiss}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {recovery?.suggestedActions && recovery.suggestedActions.length > 0 && (
        <div className="error-display__suggestions">
          <h4>Suggested Actions:</h4>
          <ul>
            {recovery.suggestedActions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="error-display__controls">
        {onRetry && recovery?.strategy === 'retry' && (
          <button 
            className="error-display__retry"
            onClick={handleRetry}
            disabled={isRetrying}
          >
            {isRetrying ? 'Retrying...' : 'Try Again'}
          </button>
        )}
        
        {onReportIssue && (
          <button 
            className="error-display__report"
            onClick={() => onReportIssue(error)}
          >
            Report Issue
          </button>
        )}

        <button 
          className="error-display__details-toggle"
          onClick={() => setDetailsExpanded(!detailsExpanded)}
        >
          {detailsExpanded ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {detailsExpanded && (
        <ErrorDetails error={error} recovery={recovery} />
      )}
    </div>
  );
};

/**
 * Error Details Component
 */
interface ErrorDetailsProps {
  error: Error;
  recovery?: ErrorRecovery;
}

const ErrorDetails: React.FC<ErrorDetailsProps> = ({ error, recovery }) => {
  const getErrorDetails = (error: Error) => {
    const details: Record<string, any> = {
      'Error Type': error.constructor.name,
      'Message': error.message,
      'Timestamp': new Date().toISOString()
    };

    if (isBlueprintError(error)) {
      details['Blueprint Type'] = error.type;
      details['Error Code'] = error.code;
      if (error.details) details['Details'] = error.details;
    } else if (isContractError(error)) {
      details['Contract Type'] = error.type;
      details['Error Code'] = error.code;
      if (error.path) details['Path'] = error.path;
      if (error.details) details['Details'] = error.details;
    } else if (isRuntimeError(error)) {
      details['Runtime Type'] = error.type;
      details['Error Code'] = error.code;
      if (error.componentId) details['Component ID'] = error.componentId;
      if (error.operationId) details['Operation ID'] = error.operationId;
      if (error.details) details['Details'] = error.details;
    } else if (isRepositoryError(error)) {
      details['Repository Type'] = error.type;
      details['Error Code'] = error.code;
      if (error.componentId) details['Component ID'] = error.componentId;
      if (error.details) details['Details'] = error.details;
    }

    if (error.stack) {
      details['Stack Trace'] = error.stack;
    }

    return details;
  };

  const details = getErrorDetails(error);

  return (
    <div className="error-details">
      <h4>Error Details</h4>
      <div className="error-details__content">
        {Object.entries(details).map(([key, value]) => (
          <div key={key} className="error-details__item">
            <span className="error-details__label">{key}:</span>
            <span className="error-details__value">
              {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
            </span>
          </div>
        ))}
      </div>

      {recovery && (
        <div className="error-details__recovery">
          <h5>Recovery Information</h5>
          <div className="error-details__item">
            <span className="error-details__label">Strategy:</span>
            <span className="error-details__value">{recovery.strategy}</span>
          </div>
          {recovery.retryOptions && (
            <div className="error-details__item">
              <span className="error-details__label">Retry Options:</span>
              <span className="error-details__value">
                Max Attempts: {recovery.retryOptions.maxAttempts}, 
                Strategy: {recovery.retryOptions.backoffStrategy}, 
                Base Delay: {recovery.retryOptions.baseDelay}ms
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Error History Component
 */
interface ErrorHistoryProps {
  errors: ErrorReport[];
  onClearHistory?: () => void;
  onRetryError?: (errorIndex: number) => void;
}

export const ErrorHistory: React.FC<ErrorHistoryProps> = ({
  errors,
  onClearHistory,
  onRetryError
}) => {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (errors.length === 0) {
    return (
      <div className="error-history error-history--empty">
        <p>No errors recorded.</p>
      </div>
    );
  }

  return (
    <div className="error-history">
      <div className="error-history__header">
        <h3>Error History ({errors.length})</h3>
        {onClearHistory && (
          <button 
            className="error-history__clear"
            onClick={onClearHistory}
          >
            Clear History
          </button>
        )}
      </div>

      <div className="error-history__list">
        {errors.map((report, index) => (
          <div 
            key={index} 
            className={`error-history__item ${report.resolved ? 'error-history__item--resolved' : ''}`}
          >
            <div 
              className="error-history__summary"
              onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
            >
              <span className="error-history__status">
                {report.resolved ? '✅' : '❌'}
              </span>
              <span className="error-history__message">
                {report.error.message}
              </span>
              <span className="error-history__time">
                {report.timestamp.toLocaleTimeString()}
              </span>
            </div>

            {expandedIndex === index && (
              <div className="error-history__details">
                <ErrorDetails error={report.error} recovery={report.recovery} />
                {!report.resolved && onRetryError && report.recovery?.strategy === 'retry' && (
                  <button 
                    className="error-history__retry"
                    onClick={() => onRetryError(index)}
                  >
                    Retry This Error
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Compact Error Banner Component
 */
interface ErrorBannerProps {
  error: Error;
  recovery?: ErrorRecovery;
  onAction?: () => void;
  onDismiss?: () => void;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  error,
  recovery,
  onAction,
  onDismiss
}) => {
  const getActionLabel = (recovery?: ErrorRecovery): string => {
    if (!recovery) return 'Details';
    
    switch (recovery.strategy) {
      case 'retry':
        return 'Retry';
      case 'user-input':
        return 'Fix';
      case 'fallback':
        return 'Use Fallback';
      case 'graceful-degradation':
        return 'Continue';
      default:
        return 'Details';
    }
  };

  return (
    <div className={`error-banner ${getSeverityClass(recovery)}`}>
      <div className="error-banner__content">
        <span className="error-banner__icon">⚠️</span>
        <span className="error-banner__message">
          {recovery?.message || error.message}
        </span>
      </div>
      <div className="error-banner__actions">
        {onAction && (
          <button 
            className="error-banner__action"
            onClick={onAction}
          >
            {getActionLabel(recovery)}
          </button>
        )}
        {onDismiss && (
          <button 
            className="error-banner__dismiss"
            onClick={onDismiss}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Type Guards
 */
function isBlueprintError(error: Error): error is BlueprintError {
  return 'type' in error && 'code' in error && 
         ['parsing', 'validation', 'ambiguity', 'generation'].includes((error as any).type);
}

function isContractError(error: Error): error is ContractError {
  return 'type' in error && 'code' in error && 
         ['validation', 'resolution', 'dependency', 'generation'].includes((error as any).type);
}

function isRuntimeError(error: Error): error is RuntimeError {
  return 'type' in error && 'code' in error && 
         ['rendering', 'operation', 'state', 'component'].includes((error as any).type);
}

function isRepositoryError(error: Error): error is RepositoryError {
  return 'type' in error && 'code' in error && 
         ['not-found', 'validation', 'dependency', 'storage'].includes((error as any).type);
}

function getSeverityClass(recovery?: ErrorRecovery): string {
  if (!recovery) return 'error-display--critical';
  
  switch (recovery.strategy) {
    case 'graceful-degradation':
      return 'error-display--warning';
    case 'fallback':
      return 'error-display--warning';
    case 'retry':
      return 'error-display--info';
    case 'user-input':
      return 'error-display--attention';
    default:
      return 'error-display--critical';
  }
}
