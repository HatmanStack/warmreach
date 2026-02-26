import { logger } from '#utils/logger.js';

export type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Signal {
  type: string;
  severity: SignalSeverity;
  timestamp: number;
  details?: string;
}

export interface ThreatAssessment {
  shouldPause: boolean;
  reason: string;
  signals: Signal[];
  threatLevel: number;
}

export interface SignalDetectorOptions {
  assessmentWindowMs?: number;
  pauseThreatThreshold?: number;
  highSignalThreshold?: number;
}

/**
 * SignalDetector aggregates multiple signals (response timing, HTTP status, content analysis)
 * to assess if the automation should pause for account safety.
 */
export class SignalDetector {
  private signals: Signal[] = [];
  private responseBaselines: Map<string, number> = new Map();
  private readonly windowMs: number;
  private readonly pauseThreatThreshold: number;
  private readonly highSignalThreshold: number;

  constructor(options: SignalDetectorOptions = {}) {
    this.windowMs = options.assessmentWindowMs || 10 * 60 * 1000; // Default 10 minutes
    this.pauseThreatThreshold = options.pauseThreatThreshold || 60;
    this.highSignalThreshold = options.highSignalThreshold || 3;
  }

  /**
   * Record a response timing signal and update baseline
   */
  recordResponseTiming(url: string, durationMs: number): void {
    const domain = this._getDomain(url);
    const baseline = this.responseBaselines.get(domain) || durationMs;
    
    // Simple EMA for baseline (alpha = 0.1)
    const newBaseline = baseline * 0.9 + durationMs * 0.1;
    this.responseBaselines.set(domain, newBaseline);

    if (durationMs > 4 * baseline) {
      this._addSignal({
        type: 'slow-response',
        severity: 'medium',
        timestamp: Date.now(),
        details: `Response time ${durationMs}ms is > 4x baseline ${Math.round(baseline)}ms`,
      });
    } else if (durationMs > 2 * baseline) {
      this._addSignal({
        type: 'slow-response',
        severity: 'low',
        timestamp: Date.now(),
        details: `Response time ${durationMs}ms is > 2x baseline ${Math.round(baseline)}ms`,
      });
    }
  }

  /**
   * Record an HTTP status signal
   */
  recordHttpStatus(url: string, statusCode: number): void {
    if (statusCode >= 200 && statusCode < 300) return;

    let severity: SignalSeverity = 'medium';
    let type = 'http-error';

    if (statusCode === 429) {
      severity = 'high';
      type = 'http-429';
    } else if (statusCode === 503) {
      severity = 'high';
      type = 'http-503';
    } else if (statusCode === 401 || statusCode === 403) {
      severity = 'high';
      type = 'http-auth-error';
    } else if (statusCode >= 500) {
      severity = 'medium';
      type = 'http-server-error';
    }

    this._addSignal({
      type,
      severity,
      timestamp: Date.now(),
      details: `HTTP ${statusCode} for ${url}`,
    });
  }

  /**
   * Record a content-based signal
   */
  recordContentSignal(signalType: string, details: string): void {
    let severity: SignalSeverity = 'medium';

    if (signalType === 'unusual-activity-banner' || signalType === 'checkpoint-detected') {
      severity = 'critical';
    } else if (signalType === 'login-redirect' || signalType === 'frequent-login-redirects') {
      severity = 'high';
    }

    this._addSignal({
      type: signalType,
      severity,
      timestamp: Date.now(),
      details,
    });
  }

  /**
   * Record an operation error
   */
  recordError(errorType: string, details: string): void {
    this._addSignal({
      type: errorType,
      severity: errorType === 'high-error-rate' ? 'high' : 'medium',
      timestamp: Date.now(),
      details,
    });
  }

  /**
   * Assess the current threat level and determine if automation should pause
   */
  assess(): ThreatAssessment {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Filter signals within the assessment window
    const recentSignals = this.signals.filter(s => s.timestamp >= windowStart);
    
    let threatLevel = 0;
    let highSignalCount = 0;
    let hasCritical = false;

    for (const signal of recentSignals) {
      switch (signal.severity) {
        case 'critical':
          threatLevel += 50;
          hasCritical = true;
          break;
        case 'high':
          threatLevel += 20;
          highSignalCount++;
          break;
        case 'medium':
          threatLevel += 5;
          break;
        case 'low':
          threatLevel += 1;
          break;
      }
    }

    const shouldPause = hasCritical || 
                       highSignalCount >= this.highSignalThreshold || 
                       threatLevel >= this.pauseThreatThreshold;

    let reason = '';
    if (shouldPause) {
      if (hasCritical) {
        const critical = recentSignals.find(s => s.severity === 'critical');
        reason = `Critical signal detected: ${critical?.type} (${critical?.details})`;
      } else if (highSignalCount >= this.highSignalThreshold) {
        reason = `High threat detected: ${highSignalCount} high-severity signals in 10 minutes`;
      } else {
        reason = `Threat level elevated to ${threatLevel}`;
      }
    }

    return {
      shouldPause,
      reason,
      signals: recentSignals,
      threatLevel,
    };
  }

  /**
   * Clear all signals and baselines
   */
  clear(): void {
    this.signals = [];
    this.responseBaselines.clear();
    logger.info('[SignalDetector] Signals and baselines cleared');
  }

  /**
   * Get current metrics for debugging
   */
  getMetrics(): object {
    return {
      signalCount: this.signals.length,
      threatLevel: this.assess().threatLevel,
      baselines: Object.fromEntries(this.responseBaselines),
    };
  }

  private _addSignal(signal: Signal): void {
    this.signals.push(signal);
    logger.debug(`[SignalDetector] Signal recorded: ${signal.type} (${signal.severity})`, { details: signal.details });
    this._evictOldSignals();
  }

  private _evictOldSignals(): void {
    const now = Date.now();
    const expiry = now - 30 * 60 * 1000; // Keep signals for 30 minutes for context, even if assessment window is shorter
    this.signals = this.signals.filter(s => s.timestamp > expiry);
    
    // For assessment we only use windowMs, but we keep them longer in the buffer.
  }

  /**
   * Get domain from URL for baseline tracking
   */
  private _getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }
}

export default SignalDetector;
