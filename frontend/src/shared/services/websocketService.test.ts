import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { websocketService } from './websocketService';

describe('WebSocketService', () => {
  let mockWs: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    };

    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(function () {
        return mockWs;
      })
    );
    websocketService.configure('ws://test');
  });

  afterEach(() => {
    websocketService.disconnect();
    vi.useRealTimers();
  });

  it('should connect and update state', () => {
    websocketService.connect('token');
    expect(websocketService.connectionState).toBe('connecting');

    // Simulate open
    if (mockWs.onopen) mockWs.onopen();
    expect(websocketService.connectionState).toBe('connected');
    expect(websocketService.connected).toBe(true);
  });

  it('should handle messages', () => {
    const handler = vi.fn();
    websocketService.onMessage(handler);

    websocketService.connect('token');
    if (mockWs.onopen) mockWs.onopen();

    // Simulate message
    const data = JSON.stringify({ action: 'test' });
    if (mockWs.onmessage) mockWs.onmessage({ data });

    expect(handler).toHaveBeenCalledWith({ action: 'test' });
  });

  it('should handle reconnection on close', () => {
    websocketService.connect('token');
    if (mockWs.onopen) mockWs.onopen();

    // Simulate unexpected close
    if (mockWs.onclose) mockWs.onclose({ code: 1006 });
    expect(websocketService.connectionState).toBe('disconnected');

    // Advance timers for reconnect
    vi.advanceTimersByTime(1000);
    expect(websocketService.connectionState).toBe('connecting');
  });

  it('should send messages when connected', () => {
    websocketService.connect('token');
    if (mockWs.onopen) mockWs.onopen();

    const result = websocketService.send({ action: 'ping' });
    expect(result).toBe(true);
    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ action: 'ping' }));
  });

  it('should not send messages when disconnected', () => {
    const result = websocketService.send({ action: 'ping' });
    expect(result).toBe(false);
    expect(mockWs.send).not.toHaveBeenCalled();
  });
});
