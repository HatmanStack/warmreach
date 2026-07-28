import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCommand } from '@/shared/hooks';
import { useToast } from '@/shared/hooks';
import { queryKeys } from '@/shared/lib/queryKeys';
// Imported from the context directly (not the feature barrel) to avoid a cycle.
import { useUserProfile } from '@/features/profile/contexts/UserProfileContext';

interface ProfileInitResult {
  success?: boolean;
  message?: string;
}

interface UseProfileInitReturn {
  isInitializing: boolean;
  initializationMessage: string;
  initializationError: string;
  initializeProfile: (onSuccess?: () => void) => Promise<void>;
  clearMessages: () => void;
}

export const useProfileInit = (): UseProfileInitReturn => {
  const [initializationMessage, setInitializationMessage] = useState<string>('');
  const [initializationError, setInitializationError] = useState<string>('');
  const [onSuccessCallback, setOnSuccessCallback] = useState<(() => void) | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { userProfile } = useUserProfile();

  const {
    execute,
    status,
    result,
    error: commandError,
    reset,
  } = useCommand<ProfileInitResult>('linkedin:profile-init');

  // Handle command completion.
  //
  // `onSuccessCallback` is deliberately NOT a dependency, and the ref is what
  // makes that safe. The effect clears the callback as its last act, so listing
  // it re-ran the effect with `status === 'completed'` still true and fired a
  // second success toast for one completion. Reading it through a ref keeps the
  // latest value without making the clear re-trigger the effect, and
  // `handledResultRef` covers the remaining case where an unrelated dependency
  // changes while the same result is still in state.
  const onSuccessCallbackRef = useRef(onSuccessCallback);
  onSuccessCallbackRef.current = onSuccessCallback;
  const handledResultRef = useRef<unknown>(null);

  useEffect(() => {
    if (status === 'completed' && result && handledResultRef.current !== result) {
      handledResultRef.current = result;
      const successMessage = result.message || 'Profile database initialized successfully!';
      setInitializationMessage(successMessage);
      toast({
        title: 'Success',
        description: 'Profile database has been initialized successfully.',
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all });
      onSuccessCallbackRef.current?.();
      setOnSuccessCallback(null);
    }
  }, [status, result, queryClient, toast]);

  useEffect(() => {
    if (status === 'failed' && commandError) {
      setInitializationError(commandError);
      toast({
        title: 'Error',
        description: commandError,
        variant: 'destructive',
      });
      setOnSuccessCallback(null);
    }
  }, [status, commandError, toast]);

  const initializeProfile = useCallback(
    async (onSuccess?: () => void) => {
      setInitializationError('');
      setInitializationMessage('');
      reset();

      if (onSuccess) {
        setOnSuccessCallback(() => onSuccess);
      }

      // Payload can be empty; commandService attaches ciphertext credentials.
      // Include collectMutuals only when the user has opted in (ADR-013); the
      // client collects nothing when the flag is absent/false.
      const collectMutuals = userProfile?.mutual_scrape_opt_in === true;
      await execute(collectMutuals ? { collectMutuals: true } : {});
    },
    [execute, reset, userProfile?.mutual_scrape_opt_in]
  );

  const clearMessages = useCallback(() => {
    setInitializationMessage('');
    setInitializationError('');
  }, []);

  const isInitializing = status === 'dispatching' || status === 'executing';

  return {
    isInitializing,
    initializationMessage,
    initializationError,
    initializeProfile,
    clearMessages,
  };
};
