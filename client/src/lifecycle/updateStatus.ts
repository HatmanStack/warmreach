/**
 * Auto-updater observability.
 *
 * The updater is the sole security-patch delivery channel for a desktop app
 * that holds LinkedIn credentials in OS keyring storage, and it used to fail
 * completely silently: an empty `error` handler plus `autoUpdater.logger = null`
 * meant a broken code-signing cert, an expired token, a GitHub rate limit, or a
 * malformed release manifest left the whole installed base unpatched with no
 * signal on either the user or the operator side.
 *
 * Extracted from `electron-main.js` so it is unit-testable — that entry point
 * runs Electron app calls at module scope and cannot be imported by a test.
 */

import { logger } from '#utils/logger.js';

export type UpdateStatusValue = 'ok' | 'error' | 'unknown';

export interface UpdateStatusSnapshot {
  /**
   * Coarse outcome of the most recent update check. `unknown` means no check
   * has completed yet — which is what distinguishes a broken channel from a
   * quiet one.
   */
  updateStatus: UpdateStatusValue;
  /** ISO timestamp of the last outcome, or null before the first one. */
  updateCheckedAt: string | null;
}

/** The subset of electron-updater's EventEmitter surface this module uses. */
/**
 * The slice of electron-updater this tracker needs. Declared with method
 * syntax, not a function-typed property: under `strictFunctionTypes` a property
 * is checked contravariantly, and electron-updater's `AppUpdater.on` is a keyed
 * event union, so the real updater was not assignable to this interface at all.
 * Method syntax is checked bivariantly, which is the intent here — this is a
 * "something with .on(name, fn)" seam that exists so the tracker can be tested
 * without Electron.
 */
interface UpdaterEvents {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

interface UpdaterError {
  message?: string;
  code?: string;
}

interface TrackerOptions {
  autoUpdater: UpdaterEvents;
  /** Called after every status transition, e.g. to re-broadcast tray status. */
  onChange?: () => void;
  now?: () => string;
}

export interface UpdateStatusTracker {
  snapshot: () => UpdateStatusSnapshot;
  /** Record a rejection from a check that never reached the `error` event. */
  recordFailure: (err: unknown, context: string) => void;
}

/**
 * Attach logging + status tracking to an electron-updater instance.
 *
 * Deliberately does NOT raise a dialog on failure: a failed update check is not
 * something the user can act on, and a modal on every launch behind a corporate
 * proxy is worse than the silence this replaces.
 *
 * `autoUpdater.logger` stays `null`. electron-updater prints a full stack trace
 * at error level for the entirely benign "no release published yet" case, which
 * is why it was silenced in the first place; logging the lifecycle events here
 * gives the same visibility without that noise.
 */
export function createUpdateStatusTracker({
  autoUpdater,
  onChange = () => {},
  now = () => new Date().toISOString(),
}: TrackerOptions): UpdateStatusTracker {
  let updateStatus: UpdateStatusValue = 'unknown';
  let updateCheckedAt: string | null = null;

  const record = (status: UpdateStatusValue): void => {
    updateStatus = status;
    updateCheckedAt = now();
    onChange();
  };

  autoUpdater.on('checking-for-update', (() => {
    logger.info('Auto-updater: checking for update');
  }) as (...args: never[]) => void);

  autoUpdater.on('update-not-available', (() => {
    logger.info('Auto-updater: no update available');
    record('ok');
  }) as (...args: never[]) => void);

  autoUpdater.on('update-available', (() => {
    logger.info('Auto-updater: update available');
    record('ok');
  }) as (...args: never[]) => void);

  autoUpdater.on('error', ((err: UpdaterError | undefined) => {
    logger.warn('Auto-updater error', { error: err?.message, code: err?.code });
    record('error');
  }) as (...args: never[]) => void);

  return {
    snapshot: () => ({ updateStatus, updateCheckedAt }),
    recordFailure: (err: unknown, context: string): void => {
      const e = err as UpdaterError | undefined;
      logger.warn(`Auto-updater ${context} failed`, { error: e?.message, code: e?.code });
      record('error');
    },
  };
}
