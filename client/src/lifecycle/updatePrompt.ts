/**
 * The "update downloaded — restart now?" prompt.
 *
 * Extracted from `electron-main.js` so it is unit-testable without an Electron
 * harness; that entry point runs Electron app calls at module scope.
 */

import { logger } from '#utils/logger.js';

/** Index of the "Restart Now" button — the only one that installs. */
const RESTART_NOW = 0;
/** Index of "Later", and the index a dismissed dialog reports. */
const LATER = 1;

interface UpdateInfo {
  version?: string;
}

/**
 * The exact message-box request this handler issues. Field types match
 * Electron's `MessageBoxOptions` so the caller can adapt the real `dialog` to
 * this seam without a cast.
 */
export interface MessageBoxRequest {
  type: 'none' | 'info' | 'error' | 'question' | 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/**
 * The slice of Electron's `dialog` this handler needs, kept electron-free so
 * the module is unit-testable. Method syntax rather than a function-typed
 * property: under `strictFunctionTypes` a property is checked contravariantly,
 * which made Electron's own `showMessageBox` unassignable to the seam.
 */
interface DialogLike {
  showMessageBox(options: MessageBoxRequest): Promise<{ response: number }>;
}

interface UpdatePromptDeps {
  dialog: DialogLike;
  autoUpdater: { quitAndInstall: () => void };
}

/**
 * Build the `update-downloaded` handler.
 *
 * Uses the async `showMessageBox` rather than `showMessageBoxSync`, which
 * blocked the Electron main process until the user clicked: an update landing
 * while the machine was unattended stopped the WebSocket heartbeat, IPC, and
 * tray updates, so the backend saw the agent as dead for the whole idle period.
 */
export function buildUpdateDownloadedHandler({
  dialog,
  autoUpdater,
}: UpdatePromptDeps): (info: UpdateInfo) => Promise<void> {
  return async (info: UpdateInfo): Promise<void> => {
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Update Ready',
        // `version` is optional on UpdateInfo, and `v${undefined}` renders as
        // "vundefined" in a dialog the user actually reads.
        message: info?.version
          ? `WarmReach Agent v${info.version} has been downloaded.`
          : 'A WarmReach Agent update has been downloaded.',
        detail: 'The update will be installed when you quit the app. Restart now?',
        buttons: ['Restart Now', 'Later'],
        defaultId: RESTART_NOW,
        // Without this, a dismissed dialog (Esc, window close) reports index 0
        // and would silently restart the app. Only reachable now that the
        // prompt is non-blocking, so it has to be pinned explicitly.
        cancelId: LATER,
      });
      if (response === RESTART_NOW) {
        autoUpdater.quitAndInstall();
      }
    } catch (err: unknown) {
      // showMessageBox rejects if the owning window is destroyed mid-prompt.
      // An unhandled rejection here would take out the update path entirely.
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('Update prompt failed', { error: error.message });
    }
  };
}
