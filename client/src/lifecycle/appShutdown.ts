/**
 * Electron shutdown wiring.
 *
 * Extracted from `electron-main.js` so it is unit-testable without a full
 * Electron harness — the entry point runs `requestSingleInstanceLock()`,
 * `app.getPath()`, and starts the Express server at module scope, so it cannot
 * be imported by a test.
 */

import { logger } from '#utils/logger.js';

/**
 * Ceiling on the browser teardown during quit. Losing this race is strictly
 * better than the previous behaviour (no cleanup at all): a wedged Chromium
 * must never make the app unquittable.
 */
export const BROWSER_CLEANUP_TIMEOUT_MS = 5_000;

interface QuitEvent {
  preventDefault: () => void;
}

interface BeforeQuitDeps {
  app: { quit: () => void };
  /**
   * Read at quit time rather than captured — `restartWebSocket()` replaces the
   * module-level binding, so a captured reference can be the wrong client.
   */
  getWsClient: () => { close?: () => void } | null | undefined;
  cleanupBrowser: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Build the single `before-quit` handler.
 *
 * Every quit path (tray Quit, `main:quit` IPC, `autoUpdater.quitAndInstall()`,
 * a bare `app.quit()`) raises `before-quit`, so one handler here covers all of
 * them. Without it, each path orphaned Chromium, and the orphan kept holding
 * the `userDataDir` profile lock — so the next launch contended with a
 * `ProcessSingleton` lock the user could only clear by killing the process.
 */
export function buildBeforeQuitHandler({
  app,
  getWsClient,
  cleanupBrowser,
  timeoutMs = BROWSER_CLEANUP_TIMEOUT_MS,
}: BeforeQuitDeps): (event: QuitEvent) => Promise<void> {
  let isQuitting = false;

  return async (event: QuitEvent): Promise<void> => {
    // Checked first, so the re-entrant `before-quit` raised by this handler's
    // own `app.quit()` below is not itself intercepted.
    if (isQuitting) return;
    isQuitting = true;
    // preventDefault is what buys the await window; without it Electron tears
    // the process down before the cleanup promise settles.
    event.preventDefault();

    try {
      getWsClient()?.close?.();
    } catch {
      /* best effort — we are quitting either way */
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanupBrowser(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('Browser cleanup failed during quit', { error: error.message });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    app.quit();
  };
}
