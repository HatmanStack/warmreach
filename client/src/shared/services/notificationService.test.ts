import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock electron
const mockShow = vi.fn();
const mockIsSupported = vi.fn(() => true);

const MockNotificationSpy = vi.fn().mockImplementation(function () {
  return {
    show: mockShow,
  };
});
// @ts-ignore
MockNotificationSpy.isSupported = mockIsSupported;

vi.mock('electron', () => ({
  Notification: MockNotificationSpy,
}));

import { NotificationService } from './notificationService.ts';
import { logger } from '#utils/logger.js';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1000000); // Set to a non-zero time
    service = new NotificationService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('notify', () => {
    it('creates and shows a native notification when available', async () => {
      await service.notify({ title: 'Test', body: 'Message' });

      expect(MockNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test',
          body: 'Message',
        })
      );
      expect(mockShow).toHaveBeenCalled();
    });

    it('rate limits notifications (max 1 per 30s)', async () => {
      await service.notify({ title: 'First', body: 'Msg' });
      await service.notify({ title: 'Second', body: 'Msg' });

      expect(MockNotificationSpy).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Rate limited'));

      // Advance time by 31s
      vi.advanceTimersByTime(31000);
      await service.notify({ title: 'Third', body: 'Msg' });
      expect(MockNotificationSpy).toHaveBeenCalledTimes(2);
    });

    it('sends critical notifications even within the rate limit window', async () => {
      await service.notify({ title: 'Normal', body: 'Msg' });
      // Within 30s — critical should bypass rate limit
      await service.notifyCheckpoint();
      expect(MockNotificationSpy).toHaveBeenCalledTimes(2);
    });

    it('uses different urgency levels', async () => {
      await service.notify({ title: 'Low', body: 'Msg', urgency: 'low' });
      expect(MockNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          silent: true,
        })
      );
    });

    it('falls back to logging if Notification is not supported', async () => {
      mockIsSupported.mockReturnValueOnce(false);
      await service.notify({ title: 'Unsupported', body: 'Msg' });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[Notification] Unsupported: Msg')
      );
    });

    it('logs with warn level for critical notifications when falling back', async () => {
      mockIsSupported.mockReturnValueOnce(false);
      await service.notify({ title: 'Critical', body: 'Msg', urgency: 'critical' });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Notification] Critical: Msg')
      );
    });
  });

  describe('convenience methods', () => {
    it('notifyCheckpoint sends correct content', async () => {
      await service.notifyCheckpoint();
      expect(MockNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'WarmReach — Action Required',
          silent: false,
        })
      );
    });

    it('notifyBackoffPause sends correct content', async () => {
      await service.notifyBackoffPause('some reason');
      expect(MockNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('some reason'),
        })
      );
    });

    it('notifyResumed sends correct content', async () => {
      await service.notifyResumed();
      expect(MockNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'WarmReach — Resumed',
          silent: true,
        })
      );
    });
  });
});
