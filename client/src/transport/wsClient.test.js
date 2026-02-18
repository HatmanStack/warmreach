import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ws module
const mockWsInstances = [];
vi.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CLOSED;
      this._listeners = {};
      mockWsInstances.push(this);
    }

    on(event, handler) {
      this._listeners[event] = this._listeners[event] || [];
      this._listeners[event].push(handler);
    }

    send(data) {
      this._sentData = this._sentData || [];
      this._sentData.push(data);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
    }

    // Test helpers
    _emit(event, ...args) {
      (this._listeners[event] || []).forEach((h) => h(...args));
    }

    _simulateOpen() {
      this.readyState = MockWebSocket.OPEN;
      this._emit('open');
    }

    _simulateMessage(data) {
      this._emit('message', Buffer.from(JSON.stringify(data)));
    }

    _simulateClose(code = 1000, reason = '') {
      this.readyState = MockWebSocket.CLOSED;
      this._emit('close', code, reason);
    }

    _simulateError(err) {
      this._emit('error', err);
    }
  }

  return { default: MockWebSocket };
});

import { WsClient } from './wsClient.js';

describe('WsClient', () => {
  let client;
  let onMessage;
  let onConnect;
  let onDisconnect;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstances.length = 0;
    onMessage = vi.fn();
    onConnect = vi.fn();
    onDisconnect = vi.fn();
    client = new WsClient({
      url: 'wss://test.example.com',
      token: 'test-jwt',
      clientType: 'agent',
      onMessage,
      onConnect,
      onDisconnect,
    });
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('creates WebSocket with token and clientType in URL', () => {
      client.connect();
      expect(mockWsInstances).toHaveLength(1);
      expect(mockWsInstances[0].url).toContain('token=test-jwt');
      expect(mockWsInstances[0].url).toContain('clientType=agent');
    });

    it('calls onConnect when WebSocket opens', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      expect(onConnect).toHaveBeenCalledOnce();
    });

    it('does nothing if already closed', () => {
      client.close();
      client.connect();
      expect(mockWsInstances).toHaveLength(0);
    });
  });

  describe('message handling', () => {
    it('parses and forwards messages to onMessage', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();

      mockWsInstances[0]._simulateMessage({ action: 'execute', commandId: 'cmd-1' });
      expect(onMessage).toHaveBeenCalledWith({ action: 'execute', commandId: 'cmd-1' });
    });

    it('ignores heartbeat echo messages', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();

      mockWsInstances[0]._simulateMessage({ action: 'heartbeat', echo: true });
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('handles malformed messages without crashing', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();

      // Emit raw invalid JSON
      mockWsInstances[0]._emit('message', Buffer.from('not-json'));
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('sends JSON data when connected', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();

      client.send({ action: 'result', commandId: 'cmd-1' });
      expect(mockWsInstances[0]._sentData).toHaveLength(1);
      expect(JSON.parse(mockWsInstances[0]._sentData[0])).toEqual({
        action: 'result',
        commandId: 'cmd-1',
      });
    });

    it('does not send when not connected', () => {
      client.connect();
      // Not opened yet
      client.send({ action: 'test' });
      expect(mockWsInstances[0]._sentData).toBeUndefined();
    });
  });

  describe('reconnection', () => {
    it('schedules reconnect on close', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      mockWsInstances[0]._simulateClose(1006, 'abnormal');

      expect(onDisconnect).toHaveBeenCalledOnce();

      // Advance past initial retry delay
      vi.advanceTimersByTime(1000);
      expect(mockWsInstances).toHaveLength(2);
    });

    it('uses exponential backoff for retries', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      mockWsInstances[0]._simulateClose(1006);

      // First retry at 1s
      vi.advanceTimersByTime(1000);
      expect(mockWsInstances).toHaveLength(2);

      mockWsInstances[1]._simulateClose(1006);
      // Second retry at 2s
      vi.advanceTimersByTime(1999);
      expect(mockWsInstances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(mockWsInstances).toHaveLength(3);
    });

    it('does not reconnect after close() is called', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      client.close();

      vi.advanceTimersByTime(60000);
      // Only the one from connect()
      expect(mockWsInstances).toHaveLength(1);
    });

    it('resets backoff on successful connection', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      mockWsInstances[0]._simulateClose(1006);

      vi.advanceTimersByTime(1000);
      mockWsInstances[1]._simulateClose(1006);

      vi.advanceTimersByTime(2000);
      // Successful open resets
      mockWsInstances[2]._simulateOpen();
      mockWsInstances[2]._simulateClose(1006);

      // Should retry at 1s again (reset), not 4s
      vi.advanceTimersByTime(1000);
      expect(mockWsInstances).toHaveLength(4);
    });
  });

  describe('heartbeat', () => {
    it('sends heartbeat every 30s when connected', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();

      vi.advanceTimersByTime(30000);
      expect(mockWsInstances[0]._sentData).toHaveLength(1);
      expect(JSON.parse(mockWsInstances[0]._sentData[0]).action).toBe('heartbeat');

      vi.advanceTimersByTime(30000);
      expect(mockWsInstances[0]._sentData).toHaveLength(2);
    });

    it('stops heartbeat on disconnect', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();

      mockWsInstances[0]._simulateClose(1000);
      vi.advanceTimersByTime(60000);
      // No heartbeats sent after close
      expect(mockWsInstances[0]._sentData).toBeUndefined();
    });
  });

  describe('connected property', () => {
    it('returns false before connecting', () => {
      expect(client.connected).toBe(false);
    });

    it('returns true when open', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      expect(client.connected).toBe(true);
    });

    it('returns false after close', () => {
      client.connect();
      mockWsInstances[0]._simulateOpen();
      mockWsInstances[0]._simulateClose(1000);
      expect(client.connected).toBe(false);
    });
  });

  describe('error handling', () => {
    it('handles WebSocket errors without crashing', () => {
      client.connect();
      mockWsInstances[0]._simulateError(new Error('connection refused'));
      // Should not throw
    });
  });
});
