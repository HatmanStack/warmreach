/**
 * Error Handler Hook for Message Generation Workflow
 * Task 9: Comprehensive error handling and user feedback
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useToast } from '@/shared/hooks';
import { MessageGenerationError } from '@/features/messages';
import { ApiError } from '@/shared/services';
import type { WorkflowError, ErrorRecoveryOptions, ErrorSeverity } from '@/shared/types/index';

export const useErrorHandler = () => {
  const { toast } = useToast();
  const [currentError, setCurrentError] = useState<WorkflowError | null>(null);
  const [errorHistory, setErrorHistory] = useState<WorkflowError[]>([]);

  // Track the pending auto-resolve timeout so it can be cleared on unmount; without
  // this the 10s fallback resolve fires after the component is gone, resolving a
  // dangling promise and risking a state-update-after-unmount.
  const autoResolveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (autoResolveTimeoutRef.current) {
        clearTimeout(autoResolveTimeoutRef.current);
        autoResolveTimeoutRef.current = null;
      }
    };
  }, []);

  const categorizeError = useCallback((error: unknown): WorkflowError['type'] => {
    if (error instanceof MessageGenerationError) {
      if (error.status === 401) return 'authentication';
      if (error.status === 429) return 'rate_limit';
      if (error.status && error.status >= 400 && error.status < 500) return 'validation';
      if (error.status && error.status >= 500) return 'api';
    }

    if (error instanceof ApiError) {
      return 'api';
    }

    if (
      error instanceof Error &&
      (error.name === 'NetworkError' || error.message?.includes('network'))
    ) {
      return 'network';
    }

    return 'unknown';
  }, []);

  const getRecoveryOptions = useCallback(
    (errorType: WorkflowError['type']): ErrorRecoveryOptions => {
      switch (errorType) {
        case 'network':
          return { retry: true, skip: true, stop: true, fallback: false };
        case 'api':
          return { retry: true, skip: true, stop: true, fallback: true };
        case 'validation':
          return { retry: false, skip: true, stop: true, fallback: false };
        case 'authentication':
          return { retry: true, skip: false, stop: true, fallback: false };
        case 'rate_limit':
          return { retry: true, skip: true, stop: true, fallback: false };
        default:
          return { retry: true, skip: true, stop: true, fallback: false };
      }
    },
    []
  );

  const getErrorSeverity = useCallback((errorType: WorkflowError['type']): ErrorSeverity => {
    switch (errorType) {
      case 'authentication':
        return 'critical';
      case 'network':
        return 'high';
      case 'api':
        return 'medium';
      case 'rate_limit':
        return 'medium';
      case 'validation':
        return 'low';
      default:
        return 'medium';
    }
  }, []);

  const createWorkflowError = useCallback(
    (
      error: unknown,
      connectionId?: string,
      connectionName?: string,
      retryCount: number = 0
    ): WorkflowError => {
      const errorType = categorizeError(error);
      const recoveryOptions = getRecoveryOptions(errorType);

      return {
        type: errorType,
        message: error instanceof Error ? error.message : 'An unexpected error occurred',
        connectionId,
        connectionName,
        recoveryOptions,
        retryCount,
        timestamp: new Date().toISOString(),
      };
    },
    [categorizeError, getRecoveryOptions]
  );

  const handleError = useCallback(
    (
      error: unknown,
      connectionId?: string,
      connectionName?: string,
      retryCount: number = 0
    ): Promise<'retry' | 'skip' | 'stop'> => {
      const workflowError = createWorkflowError(error, connectionId, connectionName, retryCount);
      setCurrentError(workflowError);
      setErrorHistory((prev) => [...prev, workflowError]);

      const severity = getErrorSeverity(workflowError.type);

      return new Promise((resolve) => {
        const actions = [];

        if (workflowError.recoveryOptions.retry) {
          actions.push({
            label: 'Retry',
            action: () => resolve('retry'),
            variant: 'default' as const,
          });
        }

        if (workflowError.recoveryOptions.skip) {
          actions.push({
            label: 'Skip',
            action: () => resolve('skip'),
            variant: 'outline' as const,
          });
        }

        if (workflowError.recoveryOptions.stop) {
          actions.push({
            label: 'Stop',
            action: () => resolve('stop'),
            variant: 'destructive' as const,
          });
        }

        // Show error toast with recovery options
        const errorTitle = connectionName
          ? `Error processing ${connectionName}`
          : 'Message generation error';

        const errorDescription =
          workflowError.message + (retryCount > 0 ? ` (Attempt ${retryCount + 1})` : '');

        toast({
          title: errorTitle,
          description: errorDescription,
          variant: severity === 'critical' || severity === 'high' ? 'destructive' : 'default',
        });

        // Auto-resolve after timeout if no user action. The timeout id is stored in
        // a ref so the cleanup effect can cancel it on unmount (and so a new error
        // supersedes a prior pending auto-resolve rather than leaking it).
        if (autoResolveTimeoutRef.current) {
          clearTimeout(autoResolveTimeoutRef.current);
        }
        autoResolveTimeoutRef.current = setTimeout(() => {
          autoResolveTimeoutRef.current = null;
          if (workflowError.recoveryOptions.skip) {
            resolve('skip');
          } else {
            resolve('stop');
          }
        }, 10000); // 10 second timeout
      });
    },
    [createWorkflowError, getErrorSeverity, toast]
  );

  const clearError = useCallback(() => {
    setCurrentError(null);
  }, []);

  const showSuccessFeedback = useCallback(
    (message: string, title: string = 'Success') => {
      toast({
        title,
        description: message,
        variant: 'default',
      });
    },
    [toast]
  );

  const showWarningFeedback = useCallback(
    (message: string, title: string = 'Warning') => {
      toast({
        title,
        description: message,
        variant: 'default',
      });
    },
    [toast]
  );

  const showInfoFeedback = useCallback(
    (message: string, title: string = 'Information') => {
      toast({
        title,
        description: message,
        variant: 'default',
      });
    },
    [toast]
  );

  return {
    currentError,
    errorHistory,
    handleError,
    clearError,
    showSuccessFeedback,
    showWarningFeedback,
    showInfoFeedback,
  };
};
