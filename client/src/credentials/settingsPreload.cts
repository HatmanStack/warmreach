/**
 * Preload script for the settings window.
 * Exposes a safe API to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface SettingsAPI {
  getCredentials: () => Promise<unknown>;
  saveCredentials: (email: string, password: string) => Promise<unknown>;
  clearCredentials: () => Promise<unknown>;
  getWsUrl: () => Promise<unknown>;
  saveWsUrl: (url: string) => Promise<unknown>;
  hasAuthToken: () => Promise<boolean>;
  saveAuthToken: (token: string) => Promise<unknown>;
  clearAuthToken: () => Promise<unknown>;
}

contextBridge.exposeInMainWorld('settingsAPI', {
  getCredentials: (): Promise<unknown> => ipcRenderer.invoke('settings:get-credentials'),
  saveCredentials: (email: string, password: string): Promise<unknown> =>
    ipcRenderer.invoke('settings:save-credentials', email, password),
  clearCredentials: (): Promise<unknown> => ipcRenderer.invoke('settings:clear-credentials'),
  getWsUrl: (): Promise<unknown> => ipcRenderer.invoke('settings:get-ws-url'),
  saveWsUrl: (url: string): Promise<unknown> => ipcRenderer.invoke('settings:save-ws-url', url),
  hasAuthToken: (): Promise<boolean> => ipcRenderer.invoke('settings:has-auth-token'),
  saveAuthToken: (token: string): Promise<unknown> =>
    ipcRenderer.invoke('settings:save-auth-token', token),
  clearAuthToken: (): Promise<unknown> => ipcRenderer.invoke('settings:clear-auth-token'),
} satisfies SettingsAPI);
