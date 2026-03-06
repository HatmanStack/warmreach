import { ApiError } from '@/shared/services';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('ErrorHandling');

/**
 * Error handling utilities for the connection management system
 * Provides consistent error handling patterns and user-friendly error messages
 */

interface ErrorWithRecovery {
  message: string;
  userMessage: string;
  recoveryActions: RecoveryAction[];
  severity: 'low' | 'medium' | 'high';
  retryable: boolean;
}

interface RecoveryAction {
  label: string;
  action: () => void | Promise<void>;
  primary?: boolean;
}

/**
 * Transform various error types into user-friendly error objects
 */
export function transformErrorForUser(
  error: unknown,
  context: string,
  recoveryActions: RecoveryAction[] = []
): ErrorWithRecovery {
  let message = 'An unexpected error occurred';
  let userMessage = 'Something went wrong. Please try again.';
  let severity: 'low' | 'medium' | 'high' = 'medium';
  let retryable = false;

  if (error instanceof ApiError) {
    message = error.message;
    retryable = error.retryable || false;

    // Map API errors to user-friendly messages
    if (error.status === 401 || error.status === 403) {
      userMessage = 'You need to sign in again to continue.';
      severity = 'high';
      recoveryActions = [
        {
          label: 'Sign In',
          action: () => {
            window.location.href = '/auth';
          },
          primary: true,
        },
        ...recoveryActions,
      ];
    } else if (error.status === 404) {
      userMessage = 'The requested information could not be found.';
      severity = 'medium';
    } else if (error.status === 429) {
      userMessage = 'Too many requests. Please wait a moment and try again.';
      severity = 'low';
      retryable = true;
    } else if (error.status && error.status >= 500) {
      userMessage = 'Our servers are experiencing issues. Please try again in a few moments.';
      severity = 'high';
      retryable = true;
    } else if (error.code === 'NETWORK_ERROR' || error.message.includes('Network error')) {
      userMessage = 'Unable to connect to our servers. Please check your internet connection.';
      severity = 'high';
      retryable = true;
    } else {
      userMessage = `Failed to ${context}. ${error.message}`;
      severity = 'medium';
    }
  } else if (error instanceof Error) {
    message = error.message;
    userMessage = `Failed to ${context}. ${error.message}`;

    // Check for specific error patterns
    if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
      userMessage = 'The request took too long. Please try again.';
      retryable = true;
      severity = 'low';
    } else if (error.message.includes('network') || error.message.includes('fetch')) {
      userMessage = 'Network connection issue. Please check your internet connection.';
      retryable = true;
      severity = 'high';
    }
  } else if (typeof error === 'string') {
    message = error;
    userMessage = `Failed to ${context}. ${error}`;
  }

  return {
    message,
    userMessage,
    recoveryActions,
    severity,
    retryable,
  };
}

/**
 * Get appropriate toast variant based on error severity
 */
export function getToastVariant(severity: 'low' | 'medium' | 'high'): 'default' | 'destructive' {
  return severity === 'low' ? 'default' : 'destructive';
}

/**
 * Create standardized error messages for common operations
 */
export const ERROR_MESSAGES = {
  FETCH_CONNECTIONS: 'load your connections',
  UPDATE_CONNECTION: 'update the connection',
  REMOVE_CONNECTION: 'remove the connection',
  FETCH_MESSAGES: 'load message history',
  SEND_MESSAGE: 'send the message',
  AUTHENTICATION: 'authenticate your request',
  NETWORK: 'connect to our servers',
  VALIDATION: 'validate the information',
  UNKNOWN: 'complete the operation',
} as const;

/**
 * Log errors with context for debugging
 */
export function logError(error: unknown, context: string, additionalData?: unknown): void {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    context,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : error,
    additionalData,
    userAgent: navigator.userAgent,
    url: window.location.href,
  };

  logger.error(`[${context}] Error occurred`, { errorInfo });

  // In production, you might want to send this to an error tracking service
  // Example: Sentry.captureException(error, { extra: errorInfo });
}
