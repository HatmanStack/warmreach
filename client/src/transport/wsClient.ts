/**
 * WebSocket client for connecting to the WarmReach backend.
 * Handles reconnection with exponential backoff.
 */

import WebSocket from 'ws';
import { logger } from '#utils/logger.js';

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
// Treat the socket as dead after ~3 missed heartbeats with no inbound frame.
// The server echoes heartbeats, so any healthy connection refreshes liveness
// at least once per HEARTBEAT_INTERVAL_MS; 3x gives slack for transient lag
// before we force a reconnect on a half-open (silently dead) TCP connection.
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;

interface WsClientOptions {
  url: string;
  token: string;
  clientType?: string;
  onMessage: (msg: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class WsClient {
  private _url: string;
  private _token: string;
  private _clientType: string;
  private _onMessage: (msg: Record<string, unknown>) => void;
  private _onConnect: () => void;
  private _onDisconnect: () => void;
  private _ws: WebSocket | null;
  private _retryMs: number;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null;
  private _closed: boolean;
  private _lastSeenAt: number;

  constructor({
    url,
    token,
    clientType = 'agent',
    onMessage,
    onConnect,
    onDisconnect,
  }: WsClientOptions) {
    this._url = url;
    this._token = token;
    this._clientType = clientType;
    this._onMessage = onMessage;
    this._onConnect = onConnect || (() => {});
    this._onDisconnect = onDisconnect || (() => {});
    this._ws = null;
    this._retryMs = INITIAL_RETRY_MS;
    this._heartbeatTimer = null;
    this._closed = false;
    this._lastSeenAt = 0;
  }

  connect(): void {
    if (this._closed) return;

    // The JWT is sent as a query param because the WebSocket handshake exposes no
    // Authorization header. Query-string tokens can surface in access logs, so the
    // API Gateway WebSocket stage access logs must be configured to scrub `token`.
    const wsUrl = `${this._url}?token=${encodeURIComponent(this._token)}&clientType=${this._clientType}`;
    logger.debug(`WS connecting to ${this._url}`);

    // Detach handlers from any prior socket so a late open/message/close/error
    // event from a dead socket cannot reach the new connection state. The prior
    // socket has already fired 'close' (that is what scheduled this reconnect),
    // so we only remove listeners — we do not close it again.
    if (this._ws) {
      this._ws.removeAllListeners();
    }

    this._ws = new WebSocket(wsUrl);

    this._ws.on('open', () => {
      logger.debug('WS connected');
      this._retryMs = INITIAL_RETRY_MS;
      this._lastSeenAt = Date.now();
      this._startHeartbeat();
      this._onConnect();
    });

    this._ws.on('message', (data: WebSocket.RawData) => {
      // Any inbound frame proves the socket is alive — record it before the
      // heartbeat-echo early-return so echoes count as liveness too.
      this._lastSeenAt = Date.now();
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.action === 'heartbeat' && msg.echo) return; // ignore heartbeat echoes
        this._onMessage(msg);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('WS message parse error', { error: error.message });
      }
    });

    this._ws.on('close', (code: number, reason: Buffer) => {
      // 1000 = normal closure; routine traffic, not worth flooding the
      // terminal. Anything else (server kicked us, network, auth) stays
      // at warn so it shows up under the new prod log level.
      const reasonStr = reason.toString();
      if (code === 1000) {
        logger.debug(`WS closed: ${code} ${reasonStr}`);
      } else {
        logger.warn(`WS closed: ${code} ${reasonStr}`);
      }
      this._stopHeartbeat();
      this._onDisconnect();
      this._scheduleReconnect();
    });

    this._ws.on('error', (err: Error) => {
      logger.error('WS error', { error: err.message });
    });
  }

  send(data: Record<string, unknown>): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  close(): void {
    this._closed = true;
    this._stopHeartbeat();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  private _startHeartbeat(): void {
    // Initialize liveness when the timer starts so the first interval does not
    // false-trip on a connection that has not yet had a chance to receive a frame.
    this._lastSeenAt = Date.now();
    this._heartbeatTimer = setInterval(() => {
      // Liveness check (#7): if no inbound frame (message or heartbeat echo)
      // has arrived within the deadline, the socket is half-open/dead. Force a
      // reconnect through the existing 'close' -> reconnect path rather than
      // adding a parallel one.
      if (Date.now() - this._lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('WS heartbeat timeout — terminating dead socket');
        const ws = this._ws;
        if (ws) {
          // terminate() force-closes a half-open socket on the Node `ws`
          // client; fall back to close() if it is unavailable. Either fires
          // the existing 'close' handler, which schedules the reconnect.
          if (typeof ws.terminate === 'function') {
            ws.terminate();
          } else {
            ws.close();
          }
        }
        return;
      }
      this.send({ action: 'heartbeat', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._closed) return;
    const cappedDelay = Math.min(this._retryMs, MAX_RETRY_MS);
    // Equal jitter: half the capped base plus a random portion of the other
    // half. Spreads reconnect attempts so clients do not all retry in lockstep
    // (thundering herd) after a shared-backend outage.
    const delay = cappedDelay / 2 + Math.random() * (cappedDelay / 2);
    logger.debug(`WS reconnecting in ${Math.round(delay)}ms`);
    setTimeout(() => this.connect(), delay);
    this._retryMs = Math.min(this._retryMs * 2, MAX_RETRY_MS);
  }
}
