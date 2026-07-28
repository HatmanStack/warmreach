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
// Bound on the outbound buffer held across a reconnect. Overflow drops the
// OLDEST frames: the newest carry the most recent command results, and an
// outbox that grew past this during one backoff window means the socket has
// been down long enough that the earliest results are already stale.
const MAX_OUTBOX = 100;

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
  private _outbox: string[];

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
    this._outbox = [];
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
      // Drain before the consumer's onConnect runs, so nothing observing the
      // reconnect can see a half-flushed outbox.
      this._flushOutbox();
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

  /**
   * Write a frame to the socket, buffering it for the next connection when the
   * socket is not OPEN.
   *
   * A dropped frame is invisible to the backend: a command result produced
   * while the socket is mid-backoff would leave the COMMAND# at `dispatched`
   * until its TTL, even though the LinkedIn action actually ran. LinkedIn
   * commands routinely run for minutes, so this overlaps reconnects in normal
   * operation.
   *
   * @returns `true` when the frame reached the socket, `false` when it was
   *   buffered or deliberately dropped. Callers may ignore the result — the
   *   outbox is the durable answer everywhere except after an explicit close().
   */
  send(data: Record<string, unknown>): boolean {
    const frame = JSON.stringify(data);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(frame);
      return true;
    }
    // Stale heartbeats are pure noise — their timestamp is already wrong by the
    // time the socket reopens, and the reconnect itself re-establishes liveness.
    if (data.action === 'heartbeat') return false;
    if (this._closed) {
      logger.warn('WS frame dropped: client is closed', { action: data.action });
      return false;
    }
    this._outbox.push(frame);
    if (this._outbox.length > MAX_OUTBOX) {
      const dropped = this._outbox.length - MAX_OUTBOX;
      this._outbox.splice(0, dropped);
      logger.warn(`WS outbox full — dropped ${dropped} oldest frame(s)`, { max: MAX_OUTBOX });
    }
    return false;
  }

  close(): void {
    this._closed = true;
    this._stopHeartbeat();
    // A deliberate shutdown must not resurrect frames on some later connect().
    this._outbox.length = 0;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Frames waiting on the next connection.
   *
   * Surfaced on the Electron tray status payload as `wsOutbox` — the Express
   * server holds no reference to this client, so it cannot report the value.
   */
  get outboxSize(): number {
    return this._outbox.length;
  }

  /**
   * Remove and return the buffered frames, for handing to a replacement client.
   *
   * A token refresh replaces the whole `WsClient` instance rather than
   * reconnecting it, so without this the outbox would be discarded by a timer
   * that happens to fire during a backoff window — losing exactly the results
   * it exists to preserve. Must be called before `close()`, which clears it.
   */
  takeOutbox(): string[] {
    return this._outbox.splice(0, this._outbox.length);
  }

  /**
   * Take on frames from a client this one replaces. Inherited frames are older
   * than anything already queued here, so they go at the head.
   */
  adoptOutbox(frames: string[]): void {
    if (frames.length === 0) return;
    this._outbox.unshift(...frames);
    if (this._outbox.length > MAX_OUTBOX) {
      const dropped = this._outbox.length - MAX_OUTBOX;
      this._outbox.splice(0, dropped);
      logger.warn(`WS outbox full after adoption — dropped ${dropped} oldest frame(s)`, {
        max: MAX_OUTBOX,
      });
    }
  }

  /**
   * Write every buffered frame in FIFO order. If the socket dies part-way
   * through, the unsent tail goes back at the head so ordering survives the
   * next reconnect.
   */
  private _flushOutbox(): void {
    if (this._outbox.length === 0) return;
    const pending = this._outbox;
    this._outbox = [];
    logger.debug(`WS flushing ${pending.length} buffered frame(s)`);
    for (let i = 0; i < pending.length; i++) {
      if (this._ws?.readyState !== WebSocket.OPEN) {
        this._outbox = pending.slice(i).concat(this._outbox);
        logger.warn(`WS flush interrupted — ${this._outbox.length} frame(s) re-queued`);
        return;
      }
      try {
        this._ws.send(pending[i]!);
      } catch (err: unknown) {
        this._outbox = pending.slice(i).concat(this._outbox);
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn(`WS flush failed — ${this._outbox.length} frame(s) re-queued`, {
          error: error.message,
        });
        return;
      }
    }
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
