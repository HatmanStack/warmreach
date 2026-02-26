import { SignalDetector } from './signalDetector.js';
import { logger } from '#utils/logger.js';

export interface SessionMetricsOptions {
  errorRateWindowMs?: number;
  checkpointWindowMs?: number;
  loginRedirectWindowMs?: number;
  errorRateThreshold?: number;
  checkpointThreshold?: number;
  loginRedirectThreshold?: number;
}

/**
 * SessionMetrics tracks operation success rates and frequency of suspicious events
 * over sliding time windows.
 */
export class SessionMetrics {
  private operations: { success: boolean; timestamp: number }[] = [];
  private checkpoints: number[] = [];
  private loginRedirects: number[] = [];

  private readonly errorRateWindowMs: number;
  private readonly checkpointWindowMs: number;
  private readonly loginRedirectWindowMs: number;
  private readonly errorRateThreshold: number;
  private readonly checkpointThreshold: number;
  private readonly loginRedirectThreshold: number;

  constructor(private detector: SignalDetector, options: SessionMetricsOptions = {}) {
    this.errorRateWindowMs = options.errorRateWindowMs || 5 * 60 * 1000; // 5 minutes
    this.checkpointWindowMs = options.checkpointWindowMs || 30 * 60 * 1000; // 30 minutes
    this.loginRedirectWindowMs = options.loginRedirectWindowMs || 10 * 60 * 1000; // 10 minutes
    
    this.errorRateThreshold = options.errorRateThreshold || 0.3; // 30%
    this.checkpointThreshold = options.checkpointThreshold || 1; // Any more than 1
    this.loginRedirectThreshold = options.loginRedirectThreshold || 2; // More than 2
  }

  /**
   * Record operation success or failure
   */
  recordOperation(success: boolean): void {
    const now = Date.now();
    this.operations.push({ success, timestamp: now });
    this._cleanup();

    const rate = this.getErrorRate();
    if (rate > this.errorRateThreshold && this._getOperationCount() >= 5) {
      this.detector.recordContentSignal('high-error-rate', `Error rate is ${Math.round(rate * 100)}%`);
    }
  }

  /**
   * Record a checkpoint detection
   */
  recordCheckpoint(): void {
    const now = Date.now();
    this.checkpoints.push(now);
    this._cleanup();

    const count = this.getCheckpointCount();
    if (count > this.checkpointThreshold) {
      this.detector.recordContentSignal('frequent-checkpoints', `${count} checkpoints in last 30 minutes`);
    }
  }

  /**
   * Record an unexpected login redirect
   */
  recordLoginRedirect(): void {
    const now = Date.now();
    this.loginRedirects.push(now);
    this._cleanup();

    const count = this.getLoginRedirectCount();
    if (count > this.loginRedirectThreshold) {
      this.detector.recordContentSignal('frequent-login-redirects', `${count} login redirects in last 10 minutes`);
    }
  }

  /**
   * Get current error rate (0-1)
   */
  getErrorRate(): number {
    const windowStart = Date.now() - this.errorRateWindowMs;
    const recentOps = this.operations.filter(op => op.timestamp >= windowStart);
    if (recentOps.length === 0) return 0;

    const failures = recentOps.filter(op => !op.success).length;
    return failures / recentOps.length;
  }

  /**
   * Get checkpoint count in window
   */
  getCheckpointCount(): number {
    const windowStart = Date.now() - this.checkpointWindowMs;
    return this.checkpoints.filter(ts => ts >= windowStart).length;
  }

  /**
   * Get login redirect count in window
   */
  getLoginRedirectCount(): number {
    const windowStart = Date.now() - this.loginRedirectWindowMs;
    return this.loginRedirects.filter(ts => ts >= windowStart).length;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.operations = [];
    this.checkpoints = [];
    this.loginRedirects = [];
    logger.info('[SessionMetrics] Metrics reset');
  }

  getMetrics(): object {
    return {
      errorRate: this.getErrorRate(),
      operationCount: this._getOperationCount(),
      checkpointCount: this.getCheckpointCount(),
      loginRedirectCount: this.getLoginRedirectCount(),
    };
  }

  private _getOperationCount(): number {
    const windowStart = Date.now() - this.errorRateWindowMs;
    return this.operations.filter(op => op.timestamp >= windowStart).length;
  }

  private _cleanup(): void {
    const now = Date.now();
    const maxWindow = Math.max(this.errorRateWindowMs, this.checkpointWindowMs, this.loginRedirectWindowMs);
    const expiry = now - maxWindow;

    this.operations = this.operations.filter(op => op.timestamp >= expiry);
    this.checkpoints = this.checkpoints.filter(ts => ts >= expiry);
    this.loginRedirects = this.loginRedirects.filter(ts => ts >= expiry);
  }
}

export default SessionMetrics;
