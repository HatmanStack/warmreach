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
  /** Command-result frames buffered while the WebSocket is down. */
  wsOutbox: number;
  /**
   * Coarse outcome of the last auto-update check. `unknown` means none has
   * completed, which is what separates a broken update channel from a quiet
   * one. The error detail is deliberately absent — it can carry release URLs
   * and tokens.
   */
  updateStatus: 'ok' | 'error' | 'unknown';
  updateCheckedAt: string | null;
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
