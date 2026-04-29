/**
 * Preload script for the main control window.
 * Exposed under window.mainAPI in the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface MainStatus {
  version: string;
  backendPort: number;
  wsConfigured: boolean;
  wsConnected: boolean;
  automationPaused: boolean;
  threatLevel: number;
}

export interface MainAPI {
  getStatus: () => Promise<MainStatus>;
  onStatus: (cb: (s: MainStatus) => void) => void;
  openApp: () => Promise<void>;
  openSettings: () => Promise<void>;
  checkUpdates: () => Promise<void>;
  togglePause: () => Promise<void>;
  quit: () => Promise<void>;
}

contextBridge.exposeInMainWorld('mainAPI', {
  getStatus: (): Promise<MainStatus> => ipcRenderer.invoke('main:get-status'),
  onStatus: (cb: (s: MainStatus) => void): void => {
    ipcRenderer.on('main:status', (_e, s: MainStatus) => cb(s));
  },
  openApp: (): Promise<void> => ipcRenderer.invoke('main:open-app'),
  openSettings: (): Promise<void> => ipcRenderer.invoke('main:open-settings'),
  checkUpdates: (): Promise<void> => ipcRenderer.invoke('main:check-updates'),
  togglePause: (): Promise<void> => ipcRenderer.invoke('main:toggle-pause'),
  quit: (): Promise<void> => ipcRenderer.invoke('main:quit'),
} satisfies MainAPI);
