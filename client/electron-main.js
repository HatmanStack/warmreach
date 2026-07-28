/**
 * Electron main process — tray app with control-window fallback.
 *
 * On platforms with system-tray support (Windows, macOS, most Linux desktops),
 * runs as a tray-only app. On platforms without it (notably ChromeOS Crostini),
 * falls back to a small control window exposing the same actions.
 */

import {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  nativeImage,
  shell,
  dialog,
  safeStorage,
} from 'electron';
import electronUpdater from 'electron-updater';
import Store from 'electron-store';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Single-instance lock — without this, launching the AppImage a second
// time spawns a fresh process that holds the same Cognito token. Both
// processes connect as clientType=agent; the backend's
// "single client per user per type" rule kicks one, it auto-reconnects,
// kicks the other, etc. The loop only breaks when one side quits.
// requestSingleInstanceLock() returns false on duplicate launches; we
// quit immediately and surface focus on the original window via the
// "second-instance" event below.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

import { envInt } from '#config';
import { logger } from '#utils/logger.js';
import { WsClient } from './src/transport/wsClient.js';
import { handleExecuteCommand } from './src/transport/commandRouter.js';
import { CredentialStore } from './src/credentials/credentialStore.js';
import { SecretStore } from './src/credentials/secretStore.js';
import { openConfigStore, LEGACY_STORE_NAME } from './src/credentials/configStore.js';
import { BrowserSessionManager } from './src/domains/session/services/browserSessionManager.js';
import { buildBeforeQuitHandler } from './src/lifecycle/appShutdown.js';
import { createUpdateStatusTracker } from './src/lifecycle/updateStatus.js';
import { buildUpdateDownloadedHandler } from './src/lifecycle/updatePrompt.js';
// Imports server.js for its side effect: starts the Express backend on
// localhost:3001 and registers structured-log error handlers.
import './src/server.js';

app.on('second-instance', () => {
  // A second launch attempt: focus the existing main window instead of
  // letting the OS spawn a duplicate WS client.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

const { autoUpdater } = electronUpdater;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the logger's userData/logs directory exists. Winston creates
// missing parents on write but only with versions ≥ 3.10; mkdir
// guarantees first-write succeeds and tells the user where to tail.
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // eslint-disable-next-line no-console -- pre-logger main-process diagnostic; this line is the user's only hint to the on-disk log path
  console.log(`[warmreach] logs: ${LOG_DIR}`);
} catch (err) {
  // eslint-disable-next-line no-console -- pre-logger main-process diagnostic
  console.error('[warmreach] failed to create log dir', LOG_DIR, err);
}

// No static encryption key. Individual secrets are sealed with safeStorage
// (OS keyring); the file itself is plain JSON. openConfigStore performs the
// one-time migration off the old statically-keyed config.json — see that
// module for why it declines to migrate when no keyring is present.
const { store, degraded: secretsDegraded } = openConfigStore({
  createStore: (options) => new Store(options),
  safeStorage,
  deleteLegacyFile: () => {
    const legacy = path.join(app.getPath('userData'), `${LEGACY_STORE_NAME}.json`);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
  },
});
const credentialStore = new CredentialStore(store, safeStorage);
const secretStore = new SecretStore(store, safeStorage);

if (secretsDegraded) {
  // eslint-disable-next-line no-console -- pre-logger main-process diagnostic; the user needs this before anything else fails
  console.warn(
    '[warmreach] No OS keyring found. Stored secrets cannot be encrypted, and ' +
      'saving LinkedIn credentials will be refused. On Linux, install and unlock ' +
      'gnome-keyring or kwallet.'
  );
}

/**
 * Persist a Cognito token, tolerating a machine with no OS keyring.
 *
 * Unlike LinkedIn credentials — where refusing to store is the whole point —
 * a token that cannot be persisted just means the user signs in again next
 * launch. Swallow the refusal so startup continues.
 */
/**
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
function setAuthSecret(key, value) {
  try {
    secretStore.setSecret(key, value, 'the session token');
    return true;
  } catch {
    return false;
  }
}

// URLs are read at call time so saving from the settings window takes
// effect immediately (no restart needed). Order: stored override → env
// override → production default.
/**
 * Read a string setting out of electron-store, which returns `unknown` because
 * the on-disk JSON is untrusted.
 * @param {string} key
 * @returns {string}
 */
function getStoredString(key) {
  const value = store.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Whether a persisted WebSocket endpoint is safe to send the auth token to.
 *
 * startWebSocket() hands the Cognito access token to whatever URL this returns,
 * in an Authorization header. `settings:save-ws-url` accepts that URL from the
 * renderer and persists it, so an unvalidated value is a token-exfiltration
 * primitive: anything that can reach that IPC channel — or edit the on-disk
 * store — can redirect the credential to a host of its choosing.
 *
 * `wss:` only, except for an explicit loopback host so local development
 * against a mock gateway still works. Plain `ws:` to a remote host would put
 * the token on the wire in clear text.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedWsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'wss:') return true;
    return (
      parsed.protocol === 'ws:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

// The shipped gateway. Named rather than repeated so the two fallback returns
// below cannot drift apart.
const DEFAULT_WS_URL = 'wss://xy7bvlt6rh.execute-api.us-east-1.amazonaws.com/prod';

/** @returns {string} */
function getWsUrl() {
  const stored = getStoredString('wsUrl');
  if (stored && !isAllowedWsUrl(stored)) {
    logger.error('Ignoring persisted wsUrl: not a wss:// endpoint', { stored });
  } else if (stored) {
    return stored;
  }

  // The env override goes through the SAME check as the persisted value. It
  // used to bypass it entirely: validation covered `stored` on both read and
  // write, so a wss:// guarantee looked enforced while WARMREACH_WS_URL — the
  // branch actually taken whenever nothing is persisted, which is the common
  // case — could point the Authorization-bearing socket at a plaintext ws://
  // or attacker-chosen host.
  const fromEnv = process.env.WARMREACH_WS_URL;
  if (fromEnv && !isAllowedWsUrl(fromEnv)) {
    logger.error('Ignoring WARMREACH_WS_URL: not a wss:// endpoint', { fromEnv });
    return DEFAULT_WS_URL;
  }
  return fromEnv || DEFAULT_WS_URL;
}
/** @returns {string} */
function getAppUrl() {
  return (
    getStoredString('appUrl') ||
    process.env.WARMREACH_APP_URL ||
    'https://prod.d88r3mhl0c0db.amplifyapp.com'
  );
}
const BACKEND_PORT = envInt('PORT', 3001);

/** @type {Tray | null} */
let tray = null;
/**
 * The live agent socket, or null while signed out or mid-restart.
 * restartWebSocket() nulls this before reconnecting, so every deref is guarded;
 * typing the nullability makes an unguarded one a compile error.
 * @type {WsClient | null}
 */
let wsClient = null;
let wsConnected = false;
/** @type {BrowserWindow | null} */
let settingsWindow = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let usingFallbackWindow = false;

const APP_ICON_PATH = path.join(__dirname, 'electron-resources', 'icon.png');

// --- Auto-updater setup ---

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
// electron-updater's own logger stays off: it prints a full stack trace for the
// entirely benign "no release published yet" case, which is what got it
// silenced originally. The tracker below logs the lifecycle events explicitly
// instead, so failures are visible without that noise.
autoUpdater.logger = null;

// Logs every update-check outcome and keeps a coarse status for the tray
// payload, so a broken delivery channel is distinguishable from a quiet one.
const updateTracker = createUpdateStatusTracker({
  autoUpdater,
  onChange: () => broadcastStatus(),
});

autoUpdater.on('update-available', (info) => {
  tray?.setToolTip(`WarmReach Agent — Downloading update v${info.version}...`);
});

// Electron's `dialog.showMessageBox` is overloaded with `(window, options)`
// declared first, and TypeScript only relates the first overload of a source
// set to a single-signature target — so `dialog` itself is not assignable to
// the testability seam in updatePrompt.ts. A one-line adapter picks the
// single-argument form explicitly, with no cast.
autoUpdater.on(
  'update-downloaded',
  buildUpdateDownloadedHandler({
    dialog: { showMessageBox: (options) => dialog.showMessageBox(options) },
    autoUpdater,
  })
);

// The `error` event is logged and recorded by updateTracker above. No dialog:
// a failed update check is not something the user can act on, and a modal on
// every launch behind a corporate proxy is worse than the previous silence.

// --- Status helpers ---

function getStatus() {
  const controller = BrowserSessionManager.getBackoffController();
  const status = controller?.getStatus();
  const pauseStatus = status?.pauseStatus || { paused: false, reason: null };
  return {
    version: app.getVersion(),
    backendPort: BACKEND_PORT,
    wsConfigured: Boolean(getWsUrl() && secretStore.hasSecret('auth.accessToken')),
    wsConnected,
    automationPaused: Boolean(pauseStatus.paused),
    threatLevel: status?.threatLevel || 0,
    // Command results buffered against a socket that is down. A number that
    // stays above zero means results are not reaching the backend, which
    // otherwise looks identical to an idle agent.
    wsOutbox: wsClient?.outboxSize ?? 0,
    // Coarse only — an updater error message can carry release URLs and tokens,
    // so it stays in the log and never crosses the IPC boundary.
    ...updateTracker.snapshot(),
  };
}

function broadcastStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:status', getStatus());
  }
}

// --- Settings window ---

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'WarmReach Agent Settings',
    icon: APP_ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'src', 'credentials', 'settingsPreload.cjs'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'src', 'credentials', 'settings.html'));
  settingsWindow.setMenuBarVisibility(false);

  // Surface preload load failures — silent normally, loud when broken.
  settingsWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    process.stderr.write(`[settings:preload-error] ${preloadPath}: ${error?.stack || error}\n`);
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// --- Main control window (tray fallback) ---

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 420,
    height: 480,
    resizable: false,
    title: 'WarmReach Agent',
    icon: APP_ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'src', 'window', 'mainPreload.cjs'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'window', 'main.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Tray ---

function togglePause() {
  const controller = BrowserSessionManager.getBackoffController();
  const status = controller?.getStatus()?.pauseStatus || { paused: false };
  if (status.paused) {
    controller?.resume();
  } else {
    controller?.pause('Manual pause');
  }
}

function updateTrayMenu() {
  if (!tray) return;

  const s = getStatus();

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const menuTemplate = [
    { label: `Automation: ${s.automationPaused ? 'PAUSED' : 'Running'}`, enabled: false },
  ];

  menuTemplate.push({
    label: s.automationPaused ? 'Resume Automation' : 'Pause Automation',
    click: () => {
      togglePause();
      updateTrayMenu();
      broadcastStatus();
    },
  });

  if (s.threatLevel > 0) {
    menuTemplate.push({ label: `Threat Level: ${s.threatLevel}/60`, enabled: false });
  }

  menuTemplate.push({ type: 'separator' });
  menuTemplate.push({ label: 'Show Status Window', click: openMainWindow });
  menuTemplate.push({ label: 'Open WarmReach', click: () => shell.openExternal(getAppUrl()) });
  menuTemplate.push({ label: 'Settings', click: openSettingsWindow });
  menuTemplate.push({ type: 'separator' });
  menuTemplate.push({
    label: 'About WarmReach Agent',
    click: () => {
      dialog.showMessageBox({
        type: 'info',
        title: 'About WarmReach Agent',
        message: `WarmReach Agent v${app.getVersion()}`,
        detail: 'LinkedIn automation agent for WarmReach.\nhttps://warmreach.com',
        buttons: ['OK'],
      });
    },
  });
  menuTemplate.push({
    label: 'Check for Updates',
    click: () => {
      autoUpdater.checkForUpdates().catch((/** @type {Error} */ err) => {
        dialog.showMessageBox({
          type: 'error',
          title: 'Update Check Failed',
          message: 'Could not check for updates.',
          detail: err.message,
        });
      });
    },
  });
  menuTemplate.push({ type: 'separator' });
  // Teardown lives in the single `before-quit` handler, which every quit path
  // raises — closing the socket here too would just be a second shutdown path.
  menuTemplate.push({ label: 'Quit', click: () => app.quit() });

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function createTray() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, 'electron-resources', 'trayIcon.png')
  );
  tray = new Tray(icon);
  tray.setToolTip('WarmReach Agent');
  updateTrayMenu();
  setInterval(() => {
    updateTrayMenu();
    broadcastStatus();
  }, 10000);
}

// --- WebSocket ---

function restartWebSocket() {
  const previous = wsClient;
  // Take the buffer before close(), which clears it, and hand it to the
  // replacement — otherwise a refresh timer firing during a backoff window
  // would discard exactly the command results the outbox exists to preserve.
  const pending = previous?.takeOutbox?.() ?? [];
  wsConnected = false;
  // No await between here and the reassignment inside startWebSocket(), so an
  // async caller (a command's progress callback, say) can never observe the
  // null. It stays null only when there is no token — i.e. signed out, where
  // dropping the frame is the correct outcome.
  wsClient = null;
  const replacement = startWebSocket();
  replacement?.adoptOutbox?.(pending);
  try {
    previous?.close?.();
  } catch {
    /* best effort */
  }
}

// --- Cognito refresh-token flow ---
//
// The web app pushes id+refresh tokens to the agent over POST /auth/token
// (handled in src/server.ts). The id token expires in ~1 hour; we use the
// refresh token to mint a new id token before that window closes so the
// WebSocket subscription stays alive without user interaction.

/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;

async function refreshIdToken() {
  const refreshToken = secretStore.getSecret('auth.refreshToken');
  const clientId = store.get('auth.cognitoClientId');
  const region = store.get('auth.region') || 'us-east-1';
  if (!refreshToken || !clientId) {
    return false;
  }
  try {
    const resp = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    });
    if (!resp.ok) {
      // 400 here usually means refresh token expired (30-day default).
      // Drop the stored credentials so the UI shows "Sign in to connect".
      const detail = await resp.text();
      // eslint-disable-next-line no-console -- pre-logger main-process diagnostic
      console.error('[electron-main] token refresh failed', resp.status, detail);
      if (resp.status === 400) {
        secretStore.deleteSecret('auth.accessToken');
        secretStore.deleteSecret('auth.refreshToken');
        restartWebSocket();
        broadcastStatus();
      }
      return false;
    }
    const data = await resp.json();
    const newIdToken = data?.AuthenticationResult?.IdToken;
    if (!newIdToken) {
      return false;
    }
    setAuthSecret('auth.accessToken', newIdToken);
    restartWebSocket();
    broadcastStatus();
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console -- pre-logger main-process diagnostic
    console.error('[electron-main] token refresh exception', err);
    return false;
  }
}

function scheduleTokenRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (!secretStore.hasSecret('auth.refreshToken')) return;
  // Cognito id tokens default to 1h validity; refresh every 50 min.
  refreshTimer = setInterval(refreshIdToken, 50 * 60 * 1000);
}

// Bridge for src/server.ts — the Express server runs in this same Node
// process so it can hand tokens straight to the main module instead of
// going through IPC.
/**
 * @param {{ idToken?: string, refreshToken?: string, cognitoClientId?: string, region?: string }} tokens
 */
globalThis.warmreachAuthSync = ({ idToken, refreshToken, cognitoClientId, region }) => {
  if (idToken) setAuthSecret('auth.accessToken', idToken);
  if (refreshToken) setAuthSecret('auth.refreshToken', refreshToken);
  if (cognitoClientId) store.set('auth.cognitoClientId', cognitoClientId);
  if (region) store.set('auth.region', region);
  restartWebSocket();
  scheduleTokenRefresh();
  broadcastStatus();
};

// Drop all stored auth state and tear down the WS so a sign-out on the
// web app doesn't leave the agent connected as the previous user (real
// problem on shared machines — refresh tokens last 30 days by default).
globalThis.warmreachAuthClear = () => {
  secretStore.deleteSecret('auth.accessToken');
  secretStore.deleteSecret('auth.refreshToken');
  store.delete('auth.cognitoClientId');
  store.delete('auth.region');
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (wsClient) {
    try {
      wsClient.close?.();
    } catch {
      /* best effort */
    }
    wsClient = null;
    wsConnected = false;
  }
  broadcastStatus();
};

/**
 * Open the agent socket, if there is a token to open it with.
 * Returns the new client so callers can act on it without re-reading the
 * module binding, which TypeScript cannot see this function reassigning.
 * @returns {WsClient | null}
 */
function startWebSocket() {
  const token = secretStore.getSecret('auth.accessToken');
  const wsUrl = getWsUrl();
  if (!token || !wsUrl) {
    return null;
  }

  wsClient = new WsClient({
    url: wsUrl,
    token,
    clientType: 'agent',
    onMessage: (msg) => {
      if (msg.action === 'execute') {
        // The frontend's command payload doesn't carry auth material
        // (and command-dispatch passes payloads through unchanged), so
        // inject what controllers need from local state here:
        //   - jwtToken     : Cognito ID token from the refresh loop
        //   - searchName   : LinkedIn email from CredentialStore
        //   - searchPassword : LinkedIn password from CredentialStore
        // Don't overwrite an explicit value already in the payload.
        if (msg.payload && typeof msg.payload === 'object') {
          // The frame is untrusted JSON off the socket; commandRouter validates
          // the payload against its per-type schema before anything drives the
          // browser (ADR-005). Here it is only a bag being augmented.
          const payload = /** @type {Record<string, unknown>} */ (msg.payload);
          const currentToken = secretStore.getSecret('auth.accessToken');
          if (currentToken && !payload.jwtToken) {
            payload.jwtToken = currentToken;
          }
          // LinkedIn creds — only the `linkedin:*` command handlers consume
          // these, so scope the injection to them rather than attaching
          // plaintext email/password to every command payload (e.g. github:*),
          // keeping the credential exposure surface as narrow as possible.
          if (
            typeof msg.type === 'string' &&
            msg.type.startsWith('linkedin:') &&
            !payload.searchName &&
            !payload.linkedinCredentialsCiphertext &&
            credentialStore.hasCredentials()
          ) {
            const creds = credentialStore.getCredentials();
            if (creds) {
              payload.searchName = creds.email;
              payload.searchPassword = creds.password;
            }
          }
        }
        // Guarded because `wsClient` is a module-level binding that
        // restartWebSocket() replaces: an unguarded deref threw a TypeError
        // inside the progress callback, and the router's catch block then
        // threw identically. `void ... .catch()` rather than `await` — the
        // message handler must not block on the command — but the promise is
        // observed, so nothing can escape unhandled.
        // handleExecuteCommand declares the validated frame shape; this is the
        // raw one. It runs validateCommandPayload on entry and rejects a
        // mismatch with a structured error, so the widening is what the
        // boundary already assumes.
        const frame = /** @type {Parameters<typeof handleExecuteCommand>[0]} */ (
          /** @type {unknown} */ (msg)
        );
        void handleExecuteCommand(frame, (data) => {
          if (!wsClient) {
            logger.warn('Dropping agent frame: WebSocket client is not initialized', {
              action: data?.action,
            });
            return false;
          }
          return wsClient.send(data);
        }).catch((/** @type {Error} */ err) => {
          logger.error('Command execution escaped the router', {
            error: err?.message,
            commandId: msg.commandId,
          });
        });
      }
    },
    onConnect: () => {
      wsConnected = true;
      tray?.setToolTip('WarmReach Agent — Connected');
      broadcastStatus();
    },
    onDisconnect: () => {
      wsConnected = false;
      tray?.setToolTip('WarmReach Agent — Disconnected');
      broadcastStatus();
    },
  });

  wsClient.connect();
  return wsClient;
}

// --- IPC: settings window ---

ipcMain.handle('settings:get-credentials', () => {
  const creds = credentialStore.getCredentials();
  return creds ? { email: creds.email } : null;
});
ipcMain.handle('settings:save-credentials', (_e, email, password) => {
  // Report the outcome rather than letting the IPC rejection surface as an
  // opaque renderer error — a refusal to store must be visible to the user,
  // not look like a successful save.
  try {
    credentialStore.setCredentials(email, password);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle('settings:clear-credentials', () => credentialStore.clearCredentials());
ipcMain.handle('settings:get-ws-url', () => store.get('wsUrl') || '');
ipcMain.handle('settings:save-ws-url', (_e, url) => {
  // Reject here as well as on read: refusing to persist keeps the bad value out
  // of the store entirely, so a later code path that forgets to validate cannot
  // pick it up.
  if (typeof url !== 'string' || !isAllowedWsUrl(url)) {
    logger.error('Refusing to save wsUrl: not a wss:// endpoint', { url });
    return { ok: false, error: 'WebSocket URL must be a wss:// endpoint' };
  }
  store.set('wsUrl', url);
  // Tear down the existing WS and reconnect against the new endpoint so the
  // change applies immediately. Routed through restartWebSocket() so there is
  // one restart path, with one null window and one outbox hand-off.
  restartWebSocket();
  broadcastStatus();
  // Same { ok } shape the sibling settings handlers use, so the renderer can
  // tell a rejected URL from a saved one instead of silently believing it took.
  return { ok: true };
});

// Auth tokens: pushed by the web app over loopback POST /auth/token
// (handled in src/server.ts via globalThis.warmreachAuthSync). No
// settings-window UI for these — manual paste was a stopgap.

// --- IPC: main control window ---

ipcMain.handle('main:get-status', () => getStatus());
ipcMain.handle('main:open-app', () => shell.openExternal(getAppUrl()));
ipcMain.handle('main:open-settings', () => openSettingsWindow());
ipcMain.handle('main:check-updates', async () => {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Update Check Failed',
      message: 'Could not check for updates.',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});
ipcMain.handle('main:toggle-pause', () => {
  togglePause();
  updateTrayMenu();
  broadcastStatus();
});
ipcMain.handle('main:quit', () => app.quit());

// --- App lifecycle ---

// The one shutdown path. Every quit route that can reach it — tray Quit, the
// main:quit IPC handler, autoUpdater.quitAndInstall() — raises `before-quit`,
// so registering here covers all of them. (The duplicate-launch app.quit() at
// the top of this file runs before any of this module is wired and follows it
// with process.exit(0); that process never launched a browser to orphan.)
// Previously nothing closed the browser on quit, and the orphaned Chromium kept
// the userDataDir profile lock held against the next launch.
app.on(
  'before-quit',
  buildBeforeQuitHandler({
    app,
    getWsClient: () => wsClient,
    cleanupBrowser: () => BrowserSessionManager.cleanup(),
  })
);

app.whenReady().then(() => {
  let trayOk = false;
  try {
    createTray();
    trayOk = true;
  } catch (err) {
    // eslint-disable-next-line no-console -- main-process startup, before any logger is wired
    console.error('[electron-main] tray creation failed:', err);
  }

  // Always open the control window on launch. On tray-capable platforms it
  // doubles as a quick status pane; closing hides to tray. On platforms
  // without a tray (ChromeOS Crostini, headless Linux), it's the only UI
  // and closing quits the app.
  usingFallbackWindow = !trayOk;
  if (process.platform === 'darwin' && trayOk) {
    app.dock?.hide();
  }
  openMainWindow();

  // If a refresh token survived from a prior session, mint a fresh
  // idToken before opening the WS — otherwise an expired idToken (1 h
  // Cognito default) would 401 and we'd wait 50 min for the refresh
  // interval to recover.
  //
  // refreshIdToken resolves a boolean rather than rejecting (so a
  // .catch handler would never fire). On success it has already
  // called restartWebSocket() itself; on transient failure (network
  // error, non-400 HTTP) we still have the stale-but-possibly-valid
  // idToken in the store and want to start the WS with it. The 400
  // case (expired refresh token) is handled inside refreshIdToken,
  // which clears creds and calls restartWebSocket() before returning
  // false — startWebSocket() then no-ops because the token is gone.
  if (secretStore.hasSecret('auth.refreshToken')) {
    refreshIdToken()
      .then((success) => {
        if (!success) startWebSocket();
      })
      .finally(() => {
        scheduleTokenRefresh();
      });
  } else {
    startWebSocket();
    scheduleTokenRefresh();
  }

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      updateTracker.recordFailure(err, 'startup check');
    });
  }, 5000);
});

app.on('window-all-closed', () => {
  // Electron passes this listener no arguments (electron.d.ts declares
  // `listener: () => void`), and merely subscribing is what suppresses the
  // default quit-on-last-window-closed. The previous body called
  // `e.preventDefault()` on that absent argument: on tray platforms it threw a
  // TypeError inside Electron's emit, and on no-tray platforms — where the
  // comment promised a quit — the branch was skipped, so the app stayed alive
  // with no window and no tray. Both directions are handled explicitly now.
  if (usingFallbackWindow) {
    app.quit();
  }
});
