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
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private shouldReconnect = false;

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
        this.reconnectDelay = 1000;
        this._startHeartbeat();
        // Set state LAST so any synchronous send() inside state handlers
        // (e.g. get_agent_status from WebSocketContext) sees the timers
        // running and ws in place.
        this._setState('connected');
      };

      socket.onmessage = (event) => {
        if (socket !== this.ws) return;
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
    logger.info(`Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ action: 'heartbeat' });
    }, 30000);
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
