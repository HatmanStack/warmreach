import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { websocketService } from './websocketService';

describe('WebSocketService', () => {
  let mockWs: any;
  // Every construction gets its own object so a test can act on a socket the
  // service has already replaced — that is what the `socket !== this.ws` guards
  // exist for. `mockWs` always points at the most recent one.
  let sockets: any[];

  const openSocket = () => {
    websocketService.connect('token');
    mockWs.onopen?.();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];

    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(function () {
        mockWs = {
          send: vi.fn(),
          close: vi.fn(),
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null,
        };
        sockets.push(mockWs);
        return mockWs;
      })
    );
    websocketService.configure('ws://test');
    // The mock is only constructed on connect(), but the existing tests below
    // reference mockWs before that; seed it with a throwaway.
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    };
  });

  afterEach(() => {
    websocketService.disconnect();
    vi.restoreAllMocks();
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

  describe('reconnect jitter', () => {
    it('spreads reconnects: the same base yields different delays for different tabs', () => {
      // Tab A: Math.random() -> 0 gives the low end of the equal-jitter window.
      vi.spyOn(Math, 'random').mockReturnValue(0);
      openSocket();
      mockWs.onclose?.({ code: 1006 });

      vi.advanceTimersByTime(499);
      expect(websocketService.connectionState).toBe('disconnected');
      vi.advanceTimersByTime(1);
      expect(websocketService.connectionState).toBe('connecting');

      websocketService.disconnect();

      // Tab B: the same 1000ms base, a different draw, a different delay.
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      openSocket();
      mockWs.onclose?.({ code: 1006 });

      vi.advanceTimersByTime(500);
      expect(websocketService.connectionState).toBe('disconnected');
      vi.advanceTimersByTime(450);
      expect(websocketService.connectionState).toBe('connecting');
    });

    it('keeps every jittered delay inside [base/2, base)', () => {
      const scheduled: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
        if (typeof ms === 'number') scheduled.push(ms);
        return realSetTimeout(fn, ms);
      }) as any);

      openSocket();
      // Base doubles 1000 -> 2000 -> 4000 ... and is capped at 30000.
      const bases = [1000, 2000, 4000, 8000, 16000];
      for (const base of bases) {
        mockWs.onclose?.({ code: 1006 });
        const delay = scheduled[scheduled.length - 1]!;
        expect(delay).toBeGreaterThanOrEqual(base / 2);
        expect(delay).toBeLessThan(base);
        // The reconnect fires and builds a fresh socket that never opens, so the
        // base keeps doubling — exactly the case jitter has to spread.
        vi.advanceTimersByTime(delay);
      }
    });

    it('resets the backoff after a successful open', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      openSocket();

      mockWs.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(500); // base was 1000, now doubled to 2000
      expect(websocketService.connectionState).toBe('connecting');

      mockWs.onopen?.(); // a successful open must put the base back to 1000
      mockWs.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(499);
      expect(websocketService.connectionState).toBe('disconnected');
      vi.advanceTimersByTime(1);
      expect(websocketService.connectionState).toBe('connecting');
    });

    it('does not reconnect after a clean 1000 close', () => {
      openSocket();
      mockWs.onclose?.({ code: 1000 });
      vi.advanceTimersByTime(60_000);
      expect(websocketService.connectionState).toBe('disconnected');
    });
  });

  describe('liveness deadline', () => {
    it('closes and reconnects a socket that has delivered nothing for three intervals', () => {
      openSocket();

      // Two intervals of silence is slack, not death.
      vi.advanceTimersByTime(90_000);
      expect(mockWs.close).not.toHaveBeenCalled();
      expect(websocketService.connectionState).toBe('connected');
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ action: 'heartbeat' }));

      const dead = mockWs;
      vi.advanceTimersByTime(30_000);
      expect(dead.close).toHaveBeenCalled();
      expect(websocketService.connectionState).toBe('disconnected');

      vi.advanceTimersByTime(1000);
      expect(websocketService.connectionState).toBe('connecting');
    });

    it('treats ANY inbound frame as proof of life, not just heartbeat echoes', () => {
      openSocket();

      vi.advanceTimersByTime(80_000);
      mockWs.onmessage?.({ data: JSON.stringify({ action: 'command_progress', step: 1 }) });

      vi.advanceTimersByTime(80_000);
      expect(mockWs.close).not.toHaveBeenCalled();
      expect(websocketService.connectionState).toBe('connected');
    });

    it('ignores a stale socket delivering late frames (the socket !== this.ws guard)', () => {
      openSocket();
      const stale = sockets[0];

      stale.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(1000);
      const current = sockets[1];
      current.onopen?.();

      // A late frame from the socket that was already replaced must not keep the
      // current one looking alive.
      vi.advanceTimersByTime(80_000);
      stale.onmessage?.({ data: JSON.stringify({ action: 'command_result' }) });

      vi.advanceTimersByTime(40_000);
      expect(current.close).toHaveBeenCalled();
      expect(websocketService.connectionState).toBe('disconnected');
    });

    it('stops the liveness timer on an explicit disconnect', () => {
      openSocket();
      const socket = mockWs;
      websocketService.disconnect();
      socket.close.mockClear();

      vi.advanceTimersByTime(300_000);
      expect(socket.close).not.toHaveBeenCalled();
      expect(websocketService.connectionState).toBe('disconnected');
    });
  });
});
