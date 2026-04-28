import { useState, useCallback, useRef, useEffect } from 'react';
import {
  commandService,
  type CommandStatus,
  type CommandProgress,
} from '@/shared/services/commandService';
import type { WebSocketMessage } from '@/shared/services/websocketService';
import { useRequireDesktopClient } from '@/shared/contexts/ClientRequiredDialogContext';

export interface UseCommandReturn<T = unknown> {
  execute: (payload: Record<string, unknown>) => Promise<void>;
  status: CommandStatus;
  progress: CommandProgress | null;
  result: T | null;
  error: string | null;
  reset: () => void;
}

interface UseCommandOptions {
  /**
   * When true, dispatches that find the desktop client offline fail
   * silently (no modal, status='failed'). Use for background/auto-fire
   * commands where popping a dialog would be aggressive. User-initiated
   * actions should leave this false (the default) so the user gets a
   * clear "install the client" prompt.
   */
  silent?: boolean;
}

/**
 * Hook for dispatching a command to the Electron agent and tracking its lifecycle.
 *
 * Every dispatch goes through the desktop-client gate: if the agent is not
 * connected, the global ClientRequiredDialog opens, the command is NOT
 * dispatched, and `execute()` resolves without changing status. Components
 * don't need to gate themselves — by architectural decision, every command
 * type runs in the Electron client.
 *
 * Pass `{ silent: true }` to suppress the modal for background/auto-fire
 * commands; the dispatch still aborts but status flips to 'failed' rather
 * than nagging the user with a dialog.
 *
 * @param type - Command type (e.g. 'linkedin:search')
 * @param options - Optional behavioral overrides
 */
export function useCommand<T = unknown>(
  type: string,
  options: UseCommandOptions = {}
): UseCommandReturn<T> {
  const { silent = false } = options;
  const { requireDesktopClient, agentConnected } = useRequireDesktopClient();
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
      // Gate: every command runs in the Electron desktop client.
      if (silent) {
        // Background/auto-fire path: don't pop a modal. Set status so the
        // caller can render a passive indicator instead.
        if (!agentConnected) {
          setError('Desktop client not connected');
          setStatus('failed');
          return;
        }
      } else if (!requireDesktopClient()) {
        // User-initiated path: open the download dialog and abort.
        return;
      }

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
        const message = err instanceof Error ? err.message : 'Failed to dispatch command';
        setError(message);
        setStatus('failed');
        throw new Error(message);
      }
    },
    [type, silent, agentConnected, requireDesktopClient]
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
