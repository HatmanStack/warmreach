import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createUpdateStatusTracker } from './updateStatus.js';
import { logger } from '#utils/logger.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('createUpdateStatusTracker (HIGH #12)', () => {
  let autoUpdater: EventEmitter;
  let onChange: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    autoUpdater = new EventEmitter();
    onChange = vi.fn<() => void>();
  });

  const build = () =>
    createUpdateStatusTracker({
      autoUpdater: autoUpdater as unknown as Parameters<
        typeof createUpdateStatusTracker
      >[0]['autoUpdater'],
      onChange,
      now: () => '2026-07-27T00:00:00.000Z',
    });

  it('starts unknown, so a channel that has never reported is distinguishable from a healthy one', () => {
    const tracker = build();
    expect(tracker.snapshot()).toEqual({ updateStatus: 'unknown', updateCheckedAt: null });
  });

  it('logs the updater error instead of swallowing it, and records error status', () => {
    const tracker = build();
    const err = Object.assign(new Error('HttpError: 403 rate limit exceeded'), {
      code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
    });

    autoUpdater.emit('error', err);

    expect(logger.warn).toHaveBeenCalledWith('Auto-updater error', {
      error: 'HttpError: 403 rate limit exceeded',
      code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
    });
    expect(tracker.snapshot()).toEqual({
      updateStatus: 'error',
      updateCheckedAt: '2026-07-27T00:00:00.000Z',
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('survives an error with no message or code', () => {
    const tracker = build();

    expect(() => autoUpdater.emit('error', undefined)).not.toThrow();
    expect(tracker.snapshot().updateStatus).toBe('error');
  });

  it('records ok when a check completes with no update available', () => {
    const tracker = build();
    autoUpdater.emit('update-not-available', { version: '1.20.0' });

    expect(logger.info).toHaveBeenCalledWith('Auto-updater: no update available');
    expect(tracker.snapshot().updateStatus).toBe('ok');
  });

  it('records ok when an update is available', () => {
    const tracker = build();
    autoUpdater.emit('update-available', { version: '1.21.0' });
    expect(tracker.snapshot().updateStatus).toBe('ok');
  });

  it('logs the start of a check', () => {
    build();
    autoUpdater.emit('checking-for-update');
    expect(logger.info).toHaveBeenCalledWith('Auto-updater: checking for update');
  });

  it('recovers to ok after an error once a later check succeeds', () => {
    const tracker = build();
    autoUpdater.emit('error', new Error('transient'));
    expect(tracker.snapshot().updateStatus).toBe('error');

    autoUpdater.emit('update-not-available', {});
    expect(tracker.snapshot().updateStatus).toBe('ok');
  });

  it('records a rejection that never reached the error event', () => {
    const tracker = build();

    tracker.recordFailure(new Error('getaddrinfo ENOTFOUND github.com'), 'startup check');

    expect(logger.warn).toHaveBeenCalledWith('Auto-updater startup check failed', {
      error: 'getaddrinfo ENOTFOUND github.com',
      code: undefined,
    });
    expect(tracker.snapshot().updateStatus).toBe('error');
  });

  it('keeps the error detail out of the snapshot, which is broadcast to renderers', () => {
    const tracker = build();
    autoUpdater.emit(
      'error',
      new Error('https://github.com/o/r/releases/download?token=SECRET 401')
    );

    // The message can carry release URLs and tokens; only the coarse outcome
    // and a timestamp may cross the IPC boundary.
    expect(Object.keys(tracker.snapshot()).sort()).toEqual(['updateCheckedAt', 'updateStatus']);
    expect(JSON.stringify(tracker.snapshot())).not.toContain('SECRET');
  });
});
