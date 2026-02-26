import { SignalDetector, ThreatAssessment } from './signalDetector.js';
import { notificationService } from '#shared/services/notificationService.js';
import InteractionQueue from './interactionQueue.js';
import { logger } from '#utils/logger.js';

export interface BackoffStatus {
  isMonitoring: boolean;
  queuePaused: boolean;
  pauseStatus: { paused: boolean; reason: string | null; pausedAt: number | null; queuedJobs: number };
  threatLevel: number;
}

/**
 * BackoffController coordinates signal detection, queue pausing, and notifications.
 */
export class BackoffController {
  private isChecking: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private detector: SignalDetector,
    private queue: InteractionQueue
  ) {}

  /**
   * Start monitoring for threats
   */
  start(intervalMs: number = 30000): void {
    if (this.checkInterval) return;
    
    this.checkInterval = setInterval(() => {
      this.assessAndAct().catch(err => {
        logger.error('[BackoffController] Error checking threats:', err);
      });
    }, intervalMs);
    
    logger.info('[BackoffController] Monitoring started');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('[BackoffController] Monitoring stopped');
  }

  /**
   * Immediately handle a detected checkpoint.
   * Bypasses the assessment interval.
   */
  async handleCheckpoint(url: string): Promise<void> {
    if (this.queue.isPaused()) return;

    this.queue.pause('Checkpoint detected');
    await notificationService.notifyCheckpoint();
    
    // Also record the signal so it shows up in metrics
    this.detector.recordContentSignal('checkpoint-detected', url);
    
    logger.warn(`[BackoffController] Checkpoint detected at ${url} — queue paused, user notified`);
  }

  /**
   * Manually trigger a threat assessment
   */
  async assessAndAct(): Promise<ThreatAssessment> {
    if (this.isChecking) return this.detector.assess();
    this.isChecking = true;

    try {
      const assessment = this.detector.assess();

      if (assessment.shouldPause && !this.queue.isPaused()) {
        const isCheckpoint = assessment.signals.some(s => s.type === 'checkpoint-detected' || s.severity === 'critical');
        
        this.queue.pause(assessment.reason);

        if (isCheckpoint) {
          await notificationService.notifyCheckpoint();
        } else {
          await notificationService.notifyBackoffPause(assessment.reason);
        }
        
        logger.warn(`[BackoffController] Automation paused due to: ${assessment.reason}`);
      }

      return assessment;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Manually pause automation from an external caller (e.g. tray menu).
   */
  pause(reason: string): void {
    if (this.queue.isPaused()) return;
    this.queue.pause(reason);
    logger.info(`[BackoffController] Automation paused manually: ${reason}`);
  }

  /**
   * Manually resume automation
   */
  async resume(): Promise<void> {
    if (!this.queue.isPaused()) return;
    
    this.queue.resume();
    this.detector.clear(); // Clear signals after manual resume
    await notificationService.notifyResumed();
    
    logger.info('[BackoffController] Automation resumed manually');
  }

  /**
   * Get current status
   */
  getStatus(): BackoffStatus {
    return {
      isMonitoring: !!this.checkInterval,
      queuePaused: this.queue.isPaused(),
      pauseStatus: this.queue.getPauseStatus(),
      threatLevel: this.detector.assess().threatLevel,
    };
  }
}

export default BackoffController;
