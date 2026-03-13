import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BurstThrottleManager } from './burstThrottleManager.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('BurstThrottleManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('uses default options', () => {
      const manager = new BurstThrottleManager();
      const status = manager.getStatus();
      expect(status.currentBurstCount).toBe(0);
      expect(status.currentBurstSize).toBeGreaterThanOrEqual(10);
      expect(status.currentBurstSize).toBeLessThanOrEqual(15);
      expect(status.isInBreak).toBe(false);
    });

    it('accepts custom options', () => {
      const manager = new BurstThrottleManager({
        minBurstSize: 5,
        maxBurstSize: 5,
      });
      const status = manager.getStatus();
      expect(status.currentBurstSize).toBe(5);
    });
  });

  describe('waitForNext', () => {
    it('applies within-burst delay between 3-8 seconds', async () => {
      const manager = new BurstThrottleManager({
        minDelayMs: 3000,
        maxDelayMs: 8000,
        minBurstSize: 100,
        maxBurstSize: 100,
      });

      const promise = manager.waitForNext();
      // Advance past max delay
      vi.advanceTimersByTime(8000);
      const result = await promise;

      expect(result.delayed).toBe(true);
      expect(result.delayMs).toBeGreaterThanOrEqual(3000);
      expect(result.delayMs).toBeLessThanOrEqual(8000);
      expect(result.isBreak).toBe(false);
    });

    it('triggers break after burst completes', async () => {
      const manager = new BurstThrottleManager({
        minBurstSize: 2,
        maxBurstSize: 2,
        minDelayMs: 100,
        maxDelayMs: 100,
        minBreakMs: 5000,
        maxBreakMs: 5000,
      });

      // First two calls complete the burst
      const p1 = manager.waitForNext();
      vi.advanceTimersByTime(100);
      await p1;

      const p2 = manager.waitForNext();
      vi.advanceTimersByTime(100);
      await p2;

      // Third call should trigger a break
      const p3 = manager.waitForNext();
      vi.advanceTimersByTime(5000);
      const result = await p3;

      expect(result.isBreak).toBe(true);
      expect(result.delayMs).toBe(5000);
    });

    it('resets burst count after break', async () => {
      const manager = new BurstThrottleManager({
        minBurstSize: 1,
        maxBurstSize: 1,
        minDelayMs: 100,
        maxDelayMs: 100,
        minBreakMs: 1000,
        maxBreakMs: 1000,
      });

      // Complete burst
      const p1 = manager.waitForNext();
      vi.advanceTimersByTime(100);
      await p1;

      // Break
      const p2 = manager.waitForNext();
      vi.advanceTimersByTime(1000);
      await p2;

      // After break, burst count should be reset
      const status = manager.getStatus();
      expect(status.currentBurstCount).toBe(1);
    });
  });

  describe('reset', () => {
    it('resets all state', async () => {
      const manager = new BurstThrottleManager({
        minBurstSize: 100,
        maxBurstSize: 100,
        minDelayMs: 100,
        maxDelayMs: 100,
      });

      const p = manager.waitForNext();
      vi.advanceTimersByTime(100);
      await p;

      expect(manager.getStatus().currentBurstCount).toBe(1);

      manager.reset();

      const status = manager.getStatus();
      expect(status.currentBurstCount).toBe(0);
      expect(status.isInBreak).toBe(false);
    });
  });

  describe('burst size randomization', () => {
    it('generates burst size within min/max range', () => {
      for (let i = 0; i < 20; i++) {
        const manager = new BurstThrottleManager({
          minBurstSize: 10,
          maxBurstSize: 15,
        });
        const status = manager.getStatus();
        expect(status.currentBurstSize).toBeGreaterThanOrEqual(10);
        expect(status.currentBurstSize).toBeLessThanOrEqual(15);
      }
    });
  });
});
