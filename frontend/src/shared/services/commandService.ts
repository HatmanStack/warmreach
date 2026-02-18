import { CognitoUserPool, CognitoUserSession } from 'amazon-cognito-identity-js';
import { cognitoConfig } from '@/config/appConfig';
import { websocketService } from './websocketService';
import type { WebSocketMessage } from './websocketService';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('CommandService');

const COMMAND_API_URL =
  import.meta.env.VITE_API_GATEWAY_URL ||
  'https://2c6mr2rri0.execute-api.us-west-2.amazonaws.com/prod';

export type CommandStatus = 'idle' | 'dispatching' | 'executing' | 'completed' | 'failed';

export interface CommandProgress {
  step: number;
  total: number;
  message: string;
}

export interface CommandState<T = unknown> {
  status: CommandStatus;
  commandId: string | null;
  progress: CommandProgress | null;
  result: T | null;
  error: string | null;
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
    const token = await this._getCognitoToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    // Attach ciphertext credentials for LinkedIn operations
    const augmentedPayload = await this._attachCredentials(type, payload);

    const response = await fetch(`${COMMAND_API_URL}/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type, payload: augmentedPayload }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const errorMsg =
        body.error || body.message || `Command dispatch failed: HTTP ${response.status}`;
      throw new Error(errorMsg);
    }

    const data = await response.json();
    return { commandId: data.commandId };
  }

  /**
   * Poll for command status (fallback when WebSocket reconnects).
   */
  async getCommandStatus(commandId: string): Promise<Record<string, unknown>> {
    const token = await this._getCognitoToken();
    const response = await fetch(`${COMMAND_API_URL}/commands/${commandId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to get command status: HTTP ${response.status}`);
    }
    return response.json();
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

  private async _attachCredentials(
    type: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
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

  private async _getCognitoToken(): Promise<string> {
    try {
      const userPool = new CognitoUserPool({
        UserPoolId: cognitoConfig.userPoolId,
        ClientId: cognitoConfig.userPoolWebClientId,
      });

      const cognitoUser = userPool.getCurrentUser();
      if (!cognitoUser) return '';

      return new Promise<string>((resolve) => {
        cognitoUser.getSession((err: Error | null, session: CognitoUserSession) => {
          if (err || !session.isValid()) {
            resolve('');
            return;
          }
          resolve(session.getIdToken().getJwtToken());
        });
      });
    } catch {
      return '';
    }
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
