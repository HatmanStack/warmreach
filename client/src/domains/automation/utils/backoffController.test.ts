import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackoffController } from './backoffController.ts';

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

describe('BackoffController', () => {
  let controller: BackoffController;
  let mockDetector: any;
  let mockQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetector = {
      assess: vi.fn(() => ({ shouldPause: false, signals: [], reason: '', threatLevel: 0 })),
      clear: vi.fn(),
      recordContentSignal: vi.fn(),
    };
    mockQueue = {
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      getPauseStatus: vi.fn(),
    };
    controller = new BackoffController(mockDetector, mockQueue);
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
      mockDetector.assess.mockReturnValue({ shouldPause: true, reason: 'Test' });
      
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
});
