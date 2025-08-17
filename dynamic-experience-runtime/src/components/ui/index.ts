/**
 * UI Components - Error handling and display components
 * Requirements: 3.5, 8.2, 8.5, 9.5
 */

// Error Display Components
export { 
  ErrorDisplay, 
  ErrorHistory, 
  ErrorBanner 
} from './ErrorDisplay';

// Error Boundary Components
export { 
  ErrorBoundary, 
  withErrorBoundary, 
  useErrorReporting, 
  useAsyncError, 
  SafeComponent 
} from './ErrorBoundary';

// Error Provider and Context
export { 
  ErrorProvider, 
  useErrorContext, 
  useErrorHandler, 
  useErrorRecovery 
} from './ErrorProvider';

// CSS Styles
import './ErrorDisplay.css';