import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackoffController } from './backoffController.js';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock notification service
vi.mock('#shared/services/notificationService.js', () => ({
  notificationService: {
    notifyCheckpoint: vi.fn(),
    notifyBackoffPause: vi.fn(),
    notifyResumed: vi.fn(),
  },
  default: {
    notifyCheckpoint: vi.fn(),
    notifyBackoffPause: vi.fn(),
    notifyResumed: vi.fn(),
  },
}));

import { notificationService } from '#shared/services/notificationService.js';

/** A threat assessment as SignalDetector.assess() returns it. */
interface Assessment {
  shouldPause: boolean;
  signals: Array<{ type: string; severity: string }>;
  reason: string;
  threatLevel: number;
}

/** The SignalDetector members BackoffController calls. */
const makeDetector = () => ({
  assess: vi.fn<() => Assessment>(() => ({
    shouldPause: false,
    signals: [],
    reason: '',
    threatLevel: 0,
  })),
  clear: vi.fn(),
  recordContentSignal: vi.fn(),
});

/** The InteractionQueue members BackoffController calls. */
const makeQueue = () => ({
  isPaused: vi.fn(() => false),
  pause: vi.fn(),
  resume: vi.fn(),
  getPauseStatus: vi.fn(),
});

describe('BackoffController', () => {
  let controller: BackoffController;
  let mockDetector: ReturnType<typeof makeDetector>;
  let mockQueue: ReturnType<typeof makeQueue>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetector = makeDetector();
    mockQueue = makeQueue();
    controller = new BackoffController(
      mockDetector as unknown as ConstructorParameters<typeof BackoffController>[0],
      mockQueue as unknown as ConstructorParameters<typeof BackoffController>[1]
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('assessAndAct', () => {
    it('pauses the queue when shouldPause is true', async () => {
      mockDetector.assess.mockReturnValue({
        shouldPause: true,
        reason: 'Too many 429s',
        signals: [{ type: 'http-429', severity: 'high' }],
        threatLevel: 60,
      });

      await controller.assessAndAct();

      expect(mockQueue.pause).toHaveBeenCalledWith('Too many 429s');
      expect(notificationService.notifyBackoffPause).toHaveBeenCalled();
    });

    it('pauses the queue and sends checkpoint notification for critical signals', async () => {
      mockDetector.assess.mockReturnValue({
        shouldPause: true,
        reason: 'Checkpoint detected',
        signals: [{ type: 'checkpoint-detected', severity: 'critical' }],
        threatLevel: 50,
      });

      await controller.assessAndAct();

      expect(mockQueue.pause).toHaveBeenCalled();
      expect(notificationService.notifyCheckpoint).toHaveBeenCalled();
    });

    it('does not pause if already paused', async () => {
      mockQueue.isPaused.mockReturnValue(true);
      mockDetector.assess.mockReturnValue({
        shouldPause: true,
        reason: 'Test',
        signals: [],
        threatLevel: 0,
      });

      await controller.assessAndAct();
      expect(mockQueue.pause).not.toHaveBeenCalled();
    });
  });

  describe('handleCheckpoint', () => {
    it('immediately pauses and notifies', async () => {
      const url = 'https://linkedin.com/checkpoint/123';
      await controller.handleCheckpoint(url);

      expect(mockQueue.pause).toHaveBeenCalledWith('Checkpoint detected');
      expect(notificationService.notifyCheckpoint).toHaveBeenCalled();
      expect(mockDetector.recordContentSignal).toHaveBeenCalledWith('checkpoint-detected', url);
    });

    it('does not pause if already paused', async () => {
      mockQueue.isPaused.mockReturnValue(true);
      await controller.handleCheckpoint('url');
      expect(mockQueue.pause).not.toHaveBeenCalled();
    });
  });

  describe('resume', () => {
    it('resumes the queue and clears detector', async () => {
      mockQueue.isPaused.mockReturnValue(true);

      await controller.resume();

      expect(mockQueue.resume).toHaveBeenCalled();
      expect(mockDetector.clear).toHaveBeenCalled();
      expect(notificationService.notifyResumed).toHaveBeenCalled();
    });
  });

  describe('monitoring', () => {
    it('starts and stops monitoring interval', () => {
      controller.start(1000);
      vi.advanceTimersByTime(1500);
      expect(mockDetector.assess).toHaveBeenCalledTimes(1);

      controller.stop();
      vi.advanceTimersByTime(1500);
      expect(mockDetector.assess).toHaveBeenCalledTimes(1); // No more calls
    });
  });

  describe('import mode', () => {
    it('switches to 10s polling while running', () => {
      controller.start(30000);
      vi.advanceTimersByTime(30000);
      expect(mockDetector.assess).toHaveBeenCalledTimes(1);

      controller.setImportMode(true);
      vi.clearAllMocks();

      // Now at 10s interval
      vi.advanceTimersByTime(10000);
      expect(mockDetector.assess).toHaveBeenCalledTimes(1);
    });

    it('sets interval for next start if not running', () => {
      controller.setImportMode(true);
      controller.start();

      vi.advanceTimersByTime(10000);
      expect(mockDetector.assess).toHaveBeenCalledTimes(1);

      // At 20s should have 2 calls (10s interval)
      vi.advanceTimersByTime(10000);
      expect(mockDetector.assess).toHaveBeenCalledTimes(2);
    });

    it('switches back to 30s polling when disabled', () => {
      controller.start(30000);
      controller.setImportMode(true);
      controller.setImportMode(false);
      vi.clearAllMocks();

      // Should be back to 30s
      vi.advanceTimersByTime(10000);
      expect(mockDetector.assess).toHaveBeenCalledTimes(0);

      vi.advanceTimersByTime(20000);
      expect(mockDetector.assess).toHaveBeenCalledTimes(1);
    });
  });
});
