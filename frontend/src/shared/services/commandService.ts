import { httpClient } from '@/shared/utils/httpClient';
import { websocketService } from './websocketService';
import type { WebSocketMessage } from './websocketService';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('CommandService');

export type CommandStatus = 'idle' | 'dispatching' | 'executing' | 'completed' | 'failed';

export interface CommandProgress {
  step: number;
  total: number;
  message: string;
}

type CommandCallback = (message: WebSocketMessage) => void;

/**
 * Service for dispatching commands to the Electron agent via backend.
 * POST /commands creates the command and dispatches it to the agent.
 * Real-time progress/results arrive over WebSocket.
 */
class CommandService {
  private commandCallbacks = new Map<string, CommandCallback>();
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this._setupMessageHandler();
  }

  /**
   * Dispatch a command and return the commandId.
   * The caller should listen for WebSocket messages with that commandId.
   */
  async dispatch(type: string, payload: Record<string, unknown>): Promise<{ commandId: string }> {
    // Attach ciphertext credentials for LinkedIn operations
    const augmentedPayload = this._attachCredentials(type, payload);

    const result = await httpClient.post<{ commandId: string }>('commands', {
      type,
      payload: augmentedPayload,
    });

    if (!result.success) {
      const errorMsg = result.error?.message || 'Command dispatch failed';
      throw new Error(errorMsg);
    }

    return { commandId: result.data!.commandId };
  }

  /**
   * Poll for command status (fallback when WebSocket reconnects).
   */
  async getCommandStatus(commandId: string): Promise<Record<string, unknown>> {
    const result = await httpClient.get<Record<string, unknown>>(`commands/${commandId}`);

    if (!result.success) {
      throw new Error(result.error?.message || `Failed to get command status`);
    }
    return result.data!;
  }

  /**
   * Register a callback for messages related to a specific commandId.
   */
  onCommandMessage(commandId: string, callback: CommandCallback): () => void {
    this.commandCallbacks.set(commandId, callback);
    return () => this.commandCallbacks.delete(commandId);
  }

  private _setupMessageHandler() {
    this.unsubscribe = websocketService.onMessage((message) => {
      const { commandId, action } = message;
      if (!commandId) return;

      // Route to command-specific callback
      const callback = this.commandCallbacks.get(commandId as string);
      if (callback) {
        callback(message);

        // Clean up on terminal actions
        if (action === 'result' || action === 'error') {
          this.commandCallbacks.delete(commandId as string);
        }
      }
    });
  }

  private _attachCredentials(
    type: string,
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const linkedInTypes = [
      'linkedin:search',
      'linkedin:send-message',
      'linkedin:add-connection',
      'linkedin:profile-init',
    ];

    if (!linkedInTypes.includes(type)) return payload;

    const ciphertext = sessionStorage.getItem('li_credentials_ciphertext');
    if (ciphertext && ciphertext.startsWith('sealbox_x25519:b64:')) {
      return { ...payload, linkedinCredentialsCiphertext: ciphertext };
    }

    logger.warn('No LinkedIn credentials found for command', { type });
    return payload;
  }

  destroy() {
    this.commandCallbacks.clear();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

export const commandService = new CommandService();
