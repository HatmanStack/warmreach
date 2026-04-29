/**
 * Electron main process — tray app with control-window fallback.
 *
 * On platforms with system-tray support (Windows, macOS, most Linux desktops),
 * runs as a tray-only app. On platforms without it (notably ChromeOS Crostini),
 * falls back to a small control window exposing the same actions.
 */

import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import Store from 'electron-store';
import path from 'path';
import { fileURLToPath } from 'url';
import { WsClient } from './src/transport/wsClient.js';
import { handleExecuteCommand } from './src/transport/commandRouter.js';
import { CredentialStore } from './src/credentials/credentialStore.js';
import { BrowserSessionManager } from './src/domains/session/services/browserSessionManager.js';
// Imports server.js for its side effect: starts the Express backend on
// localhost:3001 and registers structured-log error handlers.
import './src/server.js';

const { autoUpdater } = electronUpdater;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const store = new Store({ encryptionKey: 'warmreach-local-v1' });
const credentialStore = new CredentialStore(store);

// URLs are read at call time so saving from the settings window takes
// effect immediately (no restart needed). Order: stored override → env
// override → production default.
function getWsUrl() {
  return (
    store.get('wsUrl') ||
    process.env.WARMREACH_WS_URL ||
    'wss://xy7bvlt6rh.execute-api.us-east-1.amazonaws.com/prod'
  );
}
function getAppUrl() {
  return (
    store.get('appUrl') ||
    process.env.WARMREACH_APP_URL ||
    'https://prod.d88r3mhl0c0db.amplifyapp.com'
  );
}
const BACKEND_PORT = parseInt(process.env.PORT, 10) || 3001;

let tray = null;
let wsClient = null;
let wsConnected = false;
let settingsWindow = null;
let mainWindow = null;
let usingFallbackWindow = false;

const APP_ICON_PATH = path.join(__dirname, 'electron-resources', 'icon.png');

// --- Auto-updater setup ---

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
// Silence electron-updater's built-in logger — we surface failures via
// the "Check for Updates" dialog instead. Without this, every failed
// check (e.g. when no GitHub release exists yet) prints a stack trace.
autoUpdater.logger = null;

autoUpdater.on('update-available', (info) => {
  tray?.setToolTip(`WarmReach Agent — Downloading update v${info.version}...`);
});

autoUpdater.on('update-downloaded', (info) => {
  const response = dialog.showMessageBoxSync({
    type: 'info',
    title: 'Update Ready',
    message: `WarmReach Agent v${info.version} has been downloaded.`,
    detail: 'The update will be installed when you quit the app. Restart now?',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
  });
  if (response === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on('error', () => {
  // Silently ignore update errors — non-critical
});

// --- Status helpers ---

function getStatus() {
  const controller = BrowserSessionManager.getBackoffController();
  const status = controller?.getStatus() || { threatLevel: 0 };
  const pauseStatus = status.pauseStatus || { paused: false, reason: null };
  return {
    version: app.getVersion(),
    backendPort: BACKEND_PORT,
    wsConfigured: Boolean(getWsUrl() && store.get('auth.accessToken')),
    wsConnected,
    automationPaused: Boolean(pauseStatus.paused),
    threatLevel: status.threatLevel || 0,
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
      autoUpdater.checkForUpdates().catch((err) => {
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
  menuTemplate.push({
    label: 'Quit',
    click: () => {
      wsClient?.close();
      app.quit();
    },
  });

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
  if (wsClient) {
    try {
      wsClient.close?.();
    } catch {
      /* best effort */
    }
    wsClient = null;
    wsConnected = false;
  }
  startWebSocket();
}

// --- Cognito refresh-token flow ---
//
// The web app pushes id+refresh tokens to the agent over POST /auth/token
// (handled in src/server.ts). The id token expires in ~1 hour; we use the
// refresh token to mint a new id token before that window closes so the
// WebSocket subscription stays alive without user interaction.

let refreshTimer = null;

async function refreshIdToken() {
  const refreshToken = store.get('auth.refreshToken');
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
        store.delete('auth.accessToken');
        store.delete('auth.refreshToken');
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
    store.set('auth.accessToken', newIdToken);
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
  if (!store.get('auth.refreshToken')) return;
  // Cognito id tokens default to 1h validity; refresh every 50 min.
  refreshTimer = setInterval(refreshIdToken, 50 * 60 * 1000);
}

// Bridge for src/server.ts — the Express server runs in this same Node
// process so it can hand tokens straight to the main module instead of
// going through IPC.
globalThis.warmreachAuthSync = ({ idToken, refreshToken, cognitoClientId, region }) => {
  if (idToken) store.set('auth.accessToken', idToken);
  if (refreshToken) store.set('auth.refreshToken', refreshToken);
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
  store.delete('auth.accessToken');
  store.delete('auth.refreshToken');
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

function startWebSocket() {
  const token = store.get('auth.accessToken');
  const wsUrl = getWsUrl();
  if (!token || !wsUrl) {
    return;
  }

  wsClient = new WsClient({
    url: wsUrl,
    token,
    clientType: 'agent',
    onMessage: (msg) => {
      if (msg.action === 'execute') {
        handleExecuteCommand(msg, (data) => wsClient.send(data));
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
}

// --- IPC: settings window ---

ipcMain.handle('settings:get-credentials', () => {
  const creds = credentialStore.getCredentials();
  return creds ? { email: creds.email } : null;
});
ipcMain.handle('settings:save-credentials', (_e, email, password) => {
  credentialStore.setCredentials(email, password);
});
ipcMain.handle('settings:clear-credentials', () => credentialStore.clearCredentials());
ipcMain.handle('settings:get-ws-url', () => store.get('wsUrl') || '');
ipcMain.handle('settings:save-ws-url', (_e, url) => {
  store.set('wsUrl', url);
  // Tear down the existing WS and reconnect against the new endpoint so
  // the change applies immediately.
  if (wsClient) {
    try {
      wsClient.close?.();
    } catch {
      /* best effort */
    }
    wsClient = null;
    wsConnected = false;
  }
  startWebSocket();
  broadcastStatus();
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
      detail: err.message,
    });
  }
});
ipcMain.handle('main:toggle-pause', () => {
  togglePause();
  updateTrayMenu();
  broadcastStatus();
});
ipcMain.handle('main:quit', () => {
  wsClient?.close();
  app.quit();
});

// --- App lifecycle ---

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
  if (store.get('auth.refreshToken')) {
    refreshIdToken().finally(() => {
      startWebSocket();
      scheduleTokenRefresh();
    });
  } else {
    startWebSocket();
    scheduleTokenRefresh();
  }

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 5000);
});

app.on('window-all-closed', (e) => {
  // Tray platforms: keep running in background.
  // No-tray platforms: closing the only window quits.
  if (!usingFallbackWindow) {
    e.preventDefault();
  }
});
