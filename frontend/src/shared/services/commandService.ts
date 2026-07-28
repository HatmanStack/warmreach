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

  // Outbound LinkedIn actions that consume the daily li-actions quota. These are
  // routed through the metered /linkedin-actions gate; every other command goes
  // straight to /commands. The gate is a no-op passthrough in the community edition.
  private static readonly LI_ACTION_TYPES = new Set<string>([
    'linkedin:add-connection',
    'linkedin:send-message',
    'linkedin:follow-profile',
  ]);

  /**
   * Idempotency keys for outbound LinkedIn actions that have not landed yet,
   * keyed by the action's identity (type + caller payload).
   *
   * The gate's ambiguous-dispatch path returns 503 "please retry", and acting
   * on that message is exactly how a user sends a duplicate connect, message or
   * follow. A key regenerated per attempt would be useless, so the key is held
   * here until the action lands and reused by every retry of the same action.
   * Distinct actions get distinct keys, and a deliberate repeat of an action
   * that already succeeded gets a fresh one.
   */
  private pendingIdempotencyKeys = new Map<string, string>();

  /**
   * Bound on the map above. Entries only survive dispatches that failed, and
   * every one is a manual user action, so this is far above any real backlog —
   * it exists so a pathological failure loop cannot grow the map forever.
   */
  private static readonly MAX_PENDING_IDEMPOTENCY_KEYS = 50;

  /** Surfaced for tests: the number of un-landed actions holding a key. */
  get pendingIdempotencyKeyCount(): number {
    return this.pendingIdempotencyKeys.size;
  }

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

    // Outbound LinkedIn actions go through the metered gate (daily li-actions
    // cap); everything else dispatches straight to command-dispatch.
    const gated = CommandService.LI_ACTION_TYPES.has(type);
    const endpoint = gated ? 'linkedin-actions' : 'commands';
    // Identity is computed from the CALLER's payload, before credentials are
    // attached, so a session credential rotation does not look like a new action.
    const identity = gated ? `${type}:${JSON.stringify(payload)}` : null;
    const result = await httpClient.post<{ commandId: string }>(endpoint, {
      type,
      payload: augmentedPayload,
      ...(identity ? { idempotencyKey: this._idempotencyKeyFor(identity) } : {}),
    });

    if (!result.success) {
      // Keep the key: the next attempt at this action must carry the same one.
      const errorMsg = result.error?.message || 'Command dispatch failed';
      throw new Error(errorMsg);
    }

    // It landed. A further identical dispatch is a new, deliberate action and
    // must not be answered with this one's recorded outcome.
    if (identity) this.pendingIdempotencyKeys.delete(identity);

    return { commandId: result.data!.commandId };
  }

  private _idempotencyKeyFor(identity: string): string {
    const existing = this.pendingIdempotencyKeys.get(identity);
    if (existing) return existing;

    const key = crypto.randomUUID();
    this.pendingIdempotencyKeys.set(identity, key);
    // Map iterates in insertion order, so the first entry is the oldest.
    while (this.pendingIdempotencyKeys.size > CommandService.MAX_PENDING_IDEMPOTENCY_KEYS) {
      const oldest = this.pendingIdempotencyKeys.keys().next().value;
      if (oldest === undefined) break;
      this.pendingIdempotencyKeys.delete(oldest);
    }
    return key;
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
      'linkedin:follow-profile',
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
    this.pendingIdempotencyKeys.clear();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

export const commandService = new CommandService();
