/**
 * Preload script for the settings window.
 * Exposes a safe API to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('settingsAPI', {
  getCredentials: () => ipcRenderer.invoke('settings:get-credentials'),
  saveCredentials: (email, password) =>
    ipcRenderer.invoke('settings:save-credentials', email, password),
  clearCredentials: () => ipcRenderer.invoke('settings:clear-credentials'),
  getWsUrl: () => ipcRenderer.invoke('settings:get-ws-url'),
  saveWsUrl: (url) => ipcRenderer.invoke('settings:save-ws-url', url),
});
