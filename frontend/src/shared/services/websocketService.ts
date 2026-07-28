import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('WebSocketService');

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface WebSocketMessage {
  action: string;
  commandId?: string;
  [key: string]: unknown;
}

type MessageHandler = (message: WebSocketMessage) => void;
type StateChangeHandler = (state: ConnectionState) => void;

const HEARTBEAT_INTERVAL_MS = 30000;
// Treat the socket as dead after ~3 missed intervals with no inbound frame. The
// backend echoes heartbeats (websocket-default's `heartbeat` handler), so a
// healthy connection refreshes liveness at least once per interval; three
// intervals rather than one gives slack for a slow round-trip instead of
// churning the connection over it.
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;
const INITIAL_RECONNECT_DELAY_MS = 1000;

/**
 * WebSocket connection manager for the frontend.
 * Connects to API Gateway WebSocket API for real-time command results.
 */
class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string = '';
  private token: string = '';
  private state: ConnectionState = 'disconnected';
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateChangeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private readonly maxReconnectDelay = 30000;
  private shouldReconnect = false;
  /** Timestamp of the last inbound frame on the CURRENT socket. */
  private lastMessageAt = 0;

  get connectionState(): ConnectionState {
    return this.state;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  configure(url: string) {
    this.url = url;
  }

  connect(token: string) {
    if (this.state === 'connecting' || this.state === 'connected') return;
    if (!this.url) {
      logger.warn('WebSocket URL not configured');
      return;
    }

    this.token = token;
    this.shouldReconnect = true;
    this._connect();
  }

  disconnect() {
    this.shouldReconnect = false;
    this._clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this._setState('disconnected');
  }

  send(data: WebSocketMessage) {
    if (!this.ws || this.state !== 'connected') {
      logger.warn('Cannot send: WebSocket not connected');
      return false;
    }
    this.ws.send(JSON.stringify(data));
    return true;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private _connect() {
    this._setState('connecting');
    try {
      const separator = this.url.includes('?') ? '&' : '?';
      // Capture the socket in this closure scope so late callbacks from a
      // previous socket (StrictMode mount→cleanup→remount, or a
      // disconnect race) can't trample state that now belongs to a
      // newer socket. Every handler below checks `socket === this.ws`
      // before mutating shared state.
      const socket = new WebSocket(`${this.url}${separator}token=${this.token}&clientType=browser`);
      this.ws = socket;

      socket.onopen = () => {
        if (socket !== this.ws) return;
        logger.info('WebSocket connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this._startHeartbeat(socket);
        // Set state LAST so any synchronous send() inside state handlers
        // (e.g. get_agent_status from WebSocketContext) sees the timers
        // running and ws in place.
        this._setState('connected');
      };

      socket.onmessage = (event) => {
        if (socket !== this.ws) return;
        // Any inbound frame proves the socket is alive, not just a heartbeat
        // echo. The guard above matters here: a late frame from a socket this
        // one replaced must not make the current one look alive.
        this.lastMessageAt = Date.now();
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          this.messageHandlers.forEach((handler) => handler(message));
        } catch {
          logger.warn('Failed to parse WebSocket message');
        }
      };

      socket.onclose = (event) => {
        logger.info('WebSocket closed', { code: event.code, reason: event.reason });
        // Only react to the close of the CURRENT socket. A stale close
        // from a previous socket must not null out `this.ws` (which now
        // points at the newer socket) or flip state to disconnected.
        if (socket !== this.ws) return;
        this.ws = null;
        this._clearTimers();
        this._setState('disconnected');
        if (this.shouldReconnect && event.code !== 1000) {
          this._scheduleReconnect();
        }
      };

      socket.onerror = () => {
        if (socket !== this.ws) return;
        logger.warn('WebSocket error');
      };
    } catch (err) {
      logger.error('WebSocket connection failed', { error: err });
      this._setState('disconnected');
      if (this.shouldReconnect) {
        this._scheduleReconnect();
      }
    }
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const base = Math.min(this.reconnectDelay, this.maxReconnectDelay);
    // Equal jitter, matching client/src/transport/wsClient.ts rather than
    // inventing a third backoff policy in this repo: half the capped base plus
    // a random share of the other half. Without it every tab that lost the
    // socket at the same moment reconnects at the same moment.
    const delay = base / 2 + Math.random() * (base / 2);
    logger.info(`Reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    // The BASE doubles; only the scheduled delay is jittered.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private _startHeartbeat(socket: WebSocket) {
    this._stopHeartbeat();
    // Seed liveness at open so the first interval cannot false-trip on a socket
    // that has not yet had a chance to receive anything.
    this.lastMessageAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      // Same stale-socket guard as every other callback: a timer belonging to a
      // socket that has been replaced must not touch newer state.
      if (socket !== this.ws) return;
      if (Date.now() - this.lastMessageAt > HEARTBEAT_STALE_MS) {
        logger.warn('WebSocket liveness deadline missed; treating the socket as dead');
        this._forceReconnect(socket);
        return;
      }
      this.send({ action: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Drop a half-open socket — one that still accepts writes but delivers
   * nothing — and run the normal reconnect path.
   *
   * The disconnected transition is driven here rather than left to `onclose`
   * because a browser has no `terminate()`: `close()` on a half-open socket
   * starts a handshake the peer may never answer, so `onclose` can be minutes
   * away or never arrive. Detaching first also means the late `onclose` hits
   * the `socket !== this.ws` guard and cannot trample the replacement.
   */
  private _forceReconnect(socket: WebSocket) {
    this.ws = null;
    this._clearTimers();
    this._setState('disconnected');
    try {
      socket.close(4000, 'Liveness deadline missed');
    } catch {
      // A socket that is already gone is exactly the case being handled.
    }
    if (this.shouldReconnect) {
      this._scheduleReconnect();
    }
  }

  private _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _clearTimers() {
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.stateHandlers.forEach((handler) => handler(state));
  }
}

export const websocketService = new WebSocketService();
