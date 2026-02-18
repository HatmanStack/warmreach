/**
 * WebSocket client for connecting to the WarmReach backend.
 * Handles reconnection with exponential backoff.
 */

import WebSocket from 'ws';
import { logger } from '#utils/logger.js';

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;

export class WsClient {
  constructor({ url, token, clientType = 'agent', onMessage, onConnect, onDisconnect }) {
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
  }

  connect() {
    if (this._closed) return;

    const wsUrl = `${this._url}?token=${encodeURIComponent(this._token)}&clientType=${this._clientType}`;
    logger.info(`WS connecting to ${this._url}`);

    this._ws = new WebSocket(wsUrl);

    this._ws.on('open', () => {
      logger.info('WS connected');
      this._retryMs = INITIAL_RETRY_MS;
      this._startHeartbeat();
      this._onConnect();
    });

    this._ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === 'heartbeat' && msg.echo) return; // ignore heartbeat echoes
        this._onMessage(msg);
      } catch (err) {
        logger.error('WS message parse error', { error: err.message });
      }
    });

    this._ws.on('close', (code, reason) => {
      logger.info(`WS closed: ${code} ${reason}`);
      this._stopHeartbeat();
      this._onDisconnect();
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      logger.error('WS error', { error: err.message });
    });
  }

  send(data) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  close() {
    this._closed = true;
    this._stopHeartbeat();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  get connected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      this.send({ action: 'heartbeat', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._closed) return;
    const delay = Math.min(this._retryMs, MAX_RETRY_MS);
    logger.info(`WS reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
    this._retryMs = Math.min(this._retryMs * 2, MAX_RETRY_MS);
  }
}
