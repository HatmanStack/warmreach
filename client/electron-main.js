/**
 * Electron main process — tray-only app, no window.
 *
 * Starts the WebSocket transport and command router.
 * Tray menu provides: Open WarmReach, Settings, About, Check for Updates, Quit.
 */

import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
import path from 'path';
import { fileURLToPath } from 'url';
import { WsClient } from './src/transport/wsClient.js';
import { handleExecuteCommand } from './src/transport/commandRouter.js';
import { CredentialStore } from './src/credentials/credentialStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const store = new Store({ encryptionKey: 'warmreach-local-v1' });
const credentialStore = new CredentialStore(store);

const WS_URL = store.get('wsUrl') || process.env.WARMREACH_WS_URL || '';
const APP_URL = store.get('appUrl') || process.env.WARMREACH_APP_URL || 'https://app.warmreach.com';

let tray = null;
let wsClient = null;
let settingsWindow = null;

// --- Auto-updater setup ---

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

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
  // Silently ignore update errors — non-critical for tray app operation
});

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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'credentials', 'settingsPreload.js'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'src', 'credentials', 'settings.html'));
  settingsWindow.setMenuBarVisibility(false);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// --- Tray ---

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'electron-resources', 'trayIcon.png'));
  tray = new Tray(icon);
  tray.setToolTip('WarmReach Agent');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open WarmReach',
      click: () => shell.openExternal(APP_URL),
    },
    {
      label: 'Settings',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },
    {
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
    },
    {
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
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        wsClient?.close();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// --- WebSocket ---

function startWebSocket() {
  const token = store.get('auth.accessToken');
  if (!token || !WS_URL) {
    return;
  }

  wsClient = new WsClient({
    url: WS_URL,
    token,
    clientType: 'agent',
    onMessage: (msg) => {
      if (msg.action === 'execute') {
        handleExecuteCommand(msg, (data) => wsClient.send(data));
      }
    },
    onConnect: () => {
      tray?.setToolTip('WarmReach Agent — Connected');
    },
    onDisconnect: () => {
      tray?.setToolTip('WarmReach Agent — Disconnected');
    },
  });

  wsClient.connect();
}

// --- IPC handlers for settings window ---

ipcMain.handle('settings:get-credentials', () => {
  const creds = credentialStore.getCredentials();
  return creds ? { email: creds.email } : null;
});

ipcMain.handle('settings:save-credentials', (_event, email, password) => {
  credentialStore.setCredentials(email, password);
});

ipcMain.handle('settings:clear-credentials', () => {
  credentialStore.clearCredentials();
});

ipcMain.handle('settings:get-ws-url', () => {
  return store.get('wsUrl') || '';
});

ipcMain.handle('settings:save-ws-url', (_event, url) => {
  store.set('wsUrl', url);
});

// --- App lifecycle ---

app.whenReady().then(() => {
  // Hide dock icon on macOS (tray-only app)
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  createTray();
  startWebSocket();

  // Check for updates after a short delay (don't block startup)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 5000);
});

app.on('window-all-closed', (e) => {
  // Prevent default quit — we're a tray app
  e.preventDefault();
});
