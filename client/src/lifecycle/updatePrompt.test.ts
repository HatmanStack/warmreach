import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildUpdateDownloadedHandler } from './updatePrompt.js';
import { logger } from '#utils/logger.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('buildUpdateDownloadedHandler (MEDIUM #19)', () => {
  let dialog: { showMessageBox: ReturnType<typeof vi.fn> };
  let autoUpdater: { quitAndInstall: ReturnType<typeof vi.fn<() => void>> };

  beforeEach(() => {
    vi.clearAllMocks();
    dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };
    autoUpdater = { quitAndInstall: vi.fn<() => void>() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const build = () =>
    buildUpdateDownloadedHandler({
      dialog: dialog as unknown as Parameters<typeof buildUpdateDownloadedHandler>[0]['dialog'],
      autoUpdater,
    });

  it('installs when the user picks Restart Now', async () => {
    dialog.showMessageBox.mockResolvedValue({ response: 0 });

    await build()({ version: '1.21.0' });

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('does not install when the user picks Later', async () => {
    dialog.showMessageBox.mockResolvedValue({ response: 1 });

    await build()({ version: '1.21.0' });

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('keeps the same buttons and default, and pins cancelId to Later', async () => {
    await build()({ version: '1.21.0' });

    const options = dialog.showMessageBox.mock.calls[0]![0];
    expect(options.buttons).toEqual(['Restart Now', 'Later']);
    expect(options.defaultId).toBe(0);
    // A dismissed dialog must not be read as "Restart Now".
    expect(options.cancelId).toBe(1);
    expect(options.message).toContain('1.21.0');
  });

  it('does not install when the dialog is dismissed to cancelId', async () => {
    dialog.showMessageBox.mockResolvedValue({ response: 1 });

    await build()({ version: '1.21.0' });

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('logs and survives a dialog that rejects because the window was destroyed', async () => {
    dialog.showMessageBox.mockRejectedValue(new Error('Object has been destroyed'));

    await expect(build()({ version: '1.21.0' })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith('Update prompt failed', {
      error: 'Object has been destroyed',
    });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('yields to the event loop while the prompt is open, so timers keep firing', async () => {
    vi.useFakeTimers();
    // The dialog stays open, as it would with the machine unattended.
    let answer: (r: { response: number }) => void = () => {};
    dialog.showMessageBox.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    const heartbeat = vi.fn();
    const timer = setInterval(heartbeat, 30_000);
    try {
      const pending = build()({ version: '1.21.0' });

      // showMessageBoxSync blocked the whole main process here; the async
      // version leaves the loop free, so the heartbeat interval still runs.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(heartbeat).toHaveBeenCalledTimes(3);

      answer({ response: 1 });
      await pending;
    } finally {
      clearInterval(timer);
    }
  });
});
