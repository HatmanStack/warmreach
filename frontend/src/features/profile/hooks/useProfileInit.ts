import { useState, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCommand } from '@/shared/hooks';
import { useToast } from '@/shared/hooks';
import { queryKeys } from '@/shared/lib/queryKeys';

interface ProfileInitResult {
  success?: boolean;
  healing?: boolean;
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

  const {
    execute,
    status,
    result,
    error: commandError,
    reset,
  } = useCommand<ProfileInitResult>('linkedin:profile-init');

  // Handle command completion
  useEffect(() => {
    if (status === 'completed' && result) {
      if (result.healing) {
        const healingMessage =
          result.message || 'Profile initialization is in progress with healing...';
        setInitializationMessage(healingMessage);
        toast({
          title: 'Processing',
          description: 'Profile initialization is in progress. This may take a few minutes.',
        });
      } else {
        const successMessage = result.message || 'Profile database initialized successfully!';
        setInitializationMessage(successMessage);
        toast({
          title: 'Success',
          description: 'Profile database has been initialized successfully.',
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.connections.all });
        onSuccessCallback?.();
      }
      setOnSuccessCallback(null);
    }
  }, [status, result, queryClient, toast, onSuccessCallback]);

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

      // Payload can be empty; commandService attaches ciphertext credentials
      await execute({});
    },
    [execute, reset]
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
