import { useState, useCallback, useRef, useEffect } from 'react';
import {
  commandService,
  type CommandStatus,
  type CommandProgress,
} from '@/shared/services/commandService';
import type { WebSocketMessage } from '@/shared/services/websocketService';

interface UseCommandReturn<T = unknown> {
  execute: (payload: Record<string, unknown>) => Promise<void>;
  status: CommandStatus;
  progress: CommandProgress | null;
  result: T | null;
  error: string | null;
  reset: () => void;
}

/**
 * Hook for dispatching a command to the Electron agent and tracking its lifecycle.
 * @param type - Command type (e.g. 'linkedin:search')
 */
export function useCommand<T = unknown>(type: string): UseCommandReturn<T> {
  const [status, setStatus] = useState<CommandStatus>('idle');
  const [progress, setProgress] = useState<CommandProgress | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Clean up listener on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const execute = useCallback(
    async (payload: Record<string, unknown>) => {
      // Clean up previous command listener
      cleanupRef.current?.();
      cleanupRef.current = null;

      setStatus('dispatching');
      setProgress(null);
      setResult(null);
      setError(null);

      try {
        const { commandId } = await commandService.dispatch(type, payload);

        setStatus('executing');

        // Listen for WebSocket messages for this command
        cleanupRef.current = commandService.onCommandMessage(
          commandId,
          (message: WebSocketMessage) => {
            switch (message.action) {
              case 'progress':
                setProgress({
                  step: message.step as number,
                  total: message.total as number,
                  message: (message.message as string) || '',
                });
                break;
              case 'result':
                setResult(message.data as T);
                setStatus('completed');
                cleanupRef.current?.();
                cleanupRef.current = null;
                break;
              case 'error':
                setError((message.message as string) || 'Command failed');
                setStatus('failed');
                cleanupRef.current?.();
                cleanupRef.current = null;
                break;
            }
          }
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to dispatch command');
        setStatus('failed');
      }
    },
    [type]
  );

  const reset = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStatus('idle');
    setProgress(null);
    setResult(null);
    setError(null);
  }, []);

  return { execute, status, progress, result, error, reset };
}
