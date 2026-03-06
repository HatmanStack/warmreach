import { logger } from '#utils/logger.js';

/**
 * Urgency levels for notifications
 */
type NotificationUrgency = 'low' | 'normal' | 'critical';

/**
 * Options for a notification
 */
interface NotificationOptions {
  title: string;
  body: string;
  urgency?: NotificationUrgency;
}

/**
 * Notification service that sends native OS notifications via Electron
 * or logs them in non-Electron environments.
 */
export class NotificationService {
  private lastNotificationAt: number = 0;
  private readonly RATE_LIMIT_MS = 30000; // 30 seconds
  private NotificationClass: typeof import('electron').Notification | null = null;
  private isElectronAttempted: boolean = false;

  constructor() {}

  private async _getNotificationClass(): Promise<typeof import('electron').Notification | null> {
    if (this.isElectronAttempted) return this.NotificationClass;

    this.isElectronAttempted = true;
    try {
      const electron = await import('electron');
      if (electron && electron.Notification) {
        this.NotificationClass = electron.Notification;
      }
    } catch {
      // Not running in Electron or electron module not available
    }
    return this.NotificationClass;
  }

  /**
   * Send a native notification or log it if Electron is not available
   */
  async notify(options: NotificationOptions): Promise<void> {
    const now = Date.now();
    const { title, body, urgency = 'normal' } = options;

    // Rate limiting — critical notifications (e.g. checkpoint) always go through
    if (urgency !== 'critical' && now - this.lastNotificationAt < this.RATE_LIMIT_MS) {
      logger.debug(`[NotificationService] Rate limited: ${title} - ${body}`);
      return;
    }

    this.lastNotificationAt = now;

    const NotificationClass = await this._getNotificationClass();

    if (NotificationClass) {
      const supported = NotificationClass.isSupported();
      if (supported) {
        try {
          const notification = new NotificationClass({
            title,
            body,
            silent: urgency === 'low',
          });
          notification.show();
          logger.info(`[NotificationService] Native notification sent: ${title}`);
          return;
        } catch (error) {
          logger.error('[NotificationService] Failed to show native notification:', error);
        }
      } else {
        logger.debug('[NotificationService] Notification not supported');
      }
    }

    // Fallback to logging
    const logMethod = urgency === 'critical' ? 'warn' : 'info';
    logger[logMethod](`[Notification] ${title}: ${body}`);
  }

  /**
   * Convenience method for checkpoint detections
   */
  async notifyCheckpoint(): Promise<void> {
    await this.notify({
      title: 'WarmReach — Action Required',
      body: 'LinkedIn checkpoint detected. Automation paused. Please resolve the challenge in the browser window.',
      urgency: 'critical',
    });
  }

  /**
   * Convenience method for adaptive backoff pauses
   */
  async notifyBackoffPause(reason: string): Promise<void> {
    await this.notify({
      title: 'WarmReach — Automation Paused',
      body: `Unusual LinkedIn response detected: ${reason}. Automation paused for account safety. Resume from the tray menu when ready.`,
      urgency: 'normal',
    });
  }

  /**
   * Convenience method for automation resumes
   */
  async notifyResumed(): Promise<void> {
    await this.notify({
      title: 'WarmReach — Resumed',
      body: 'Automation has resumed normal operation.',
      urgency: 'low',
    });
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
