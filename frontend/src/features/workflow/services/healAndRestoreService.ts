import { websocketService } from '@/shared/services';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('HealAndRestoreService');

export interface HealAndRestoreSession {
  sessionId: string;
  timestamp: number;
  status: 'pending' | 'authorized' | 'cancelled' | 'completed';
}

export interface HealAndRestoreNotification {
  sessionId: string;
  message: string;
  timestamp: number;
}

class HealAndRestoreService {
  private listeners: ((notification: HealAndRestoreNotification) => void)[] = [];
  private isListening = false;
  private ignoredSessionIds: Set<string> = new Set();
  private unsubscribe: (() => void) | null = null;

  // Check if auto-approve is enabled for this session
  isAutoApproveEnabled(): boolean {
    return sessionStorage.getItem('autoApproveHealRestore') === 'true';
  }

  // Set auto-approve preference
  setAutoApprove(enabled: boolean): void {
    if (enabled) {
      sessionStorage.setItem('autoApproveHealRestore', 'true');
    } else {
      sessionStorage.removeItem('autoApproveHealRestore');
    }
  }

  // Send authorization to backend via WebSocket
  async authorizeHealAndRestore(sessionId: string, autoApprove: boolean = false): Promise<boolean> {
    try {
      this.ignoredSessionIds.delete(sessionId);
      return websocketService.send({
        action: 'heal_authorize',
        sessionId,
        autoApprove,
      });
    } catch (error) {
      logger.error('Failed to authorize heal and restore', { error });
      return false;
    }
  }

  // Send cancel to backend via WebSocket
  async cancelHealAndRestore(sessionId: string): Promise<boolean> {
    try {
      this.ignoredSessionIds.add(sessionId);
      return websocketService.send({
        action: 'heal_cancel',
        sessionId,
      });
    } catch (error) {
      logger.error('Failed to cancel heal and restore', { error });
      return false;
    }
  }

  // Start listening for heal and restore notifications via WebSocket
  startListening(): void {
    if (this.isListening) return;
    this.isListening = true;

    this.unsubscribe = websocketService.onMessage((message) => {
      if (message.action !== 'heal_request') return;

      const notification: HealAndRestoreNotification = {
        sessionId: message.sessionId as string,
        message: (message.message as string) || 'Heal and restore authorization required',
        timestamp: Date.now(),
      };

      if (this.isAutoApproveEnabled()) {
        this.authorizeHealAndRestore(notification.sessionId, true);
      } else if (!this.ignoredSessionIds.has(notification.sessionId)) {
        this.notifyListeners(notification);
      }
    });
  }

  // Stop listening for notifications
  stopListening(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.isListening = false;
  }

  // Add listener for heal and restore notifications
  addListener(callback: (notification: HealAndRestoreNotification) => void): void {
    this.listeners.push(callback);
  }

  // Remove listener
  removeListener(callback: (notification: HealAndRestoreNotification) => void): void {
    this.listeners = this.listeners.filter((listener) => listener !== callback);
  }

  // Notify all listeners
  private notifyListeners(notification: HealAndRestoreNotification): void {
    this.listeners.forEach((listener) => listener(notification));
  }
}

export const healAndRestoreService = new HealAndRestoreService();
export default healAndRestoreService;
