import { logger } from '#utils/logger.js';

type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';

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

interface SignalDetectorOptions {
  assessmentWindowMs?: number;
  pauseThreatThreshold?: number;
  highSignalThreshold?: number;
}

interface DomainStats {
  mean: number;
  variance: number;
  count: number;
}

const EMA_ALPHA = 0.1;
const COLD_START_THRESHOLD = 3;
const ADAPTIVE_MEDIUM_STDDEV = 3;
const ADAPTIVE_LOW_STDDEV = 2;
const STATIC_MEDIUM_MULTIPLIER = 4;
const STATIC_LOW_MULTIPLIER = 2;

/**
 * SignalDetector aggregates multiple signals (response timing, HTTP status, content analysis)
 * to assess if the automation should pause for account safety.
 */
export class SignalDetector {
  private signals: Signal[] = [];
  private domainStats: Map<string, DomainStats> = new Map();
  private readonly windowMs: number;
  private readonly pauseThreatThreshold: number;
  private readonly highSignalThreshold: number;

  constructor(options: SignalDetectorOptions = {}) {
    this.windowMs = options.assessmentWindowMs || 10 * 60 * 1000; // Default 10 minutes
    this.pauseThreatThreshold = options.pauseThreatThreshold || 60;
    this.highSignalThreshold = options.highSignalThreshold || 3;
  }

  /**
   * Record a response timing signal and update baseline with adaptive thresholds.
   * Uses EMA-based variance tracking. Falls back to static multipliers during
   * cold start (fewer than COLD_START_THRESHOLD data points).
   */
  recordResponseTiming(url: string, durationMs: number): void {
    const domain = this._getDomain(url);
    const stats = this.domainStats.get(domain) || {
      mean: durationMs,
      variance: 0,
      count: 0,
    };

    // Compute thresholds from pre-update stats
    let mediumThreshold: number;
    let lowThreshold: number;

    if (stats.count < COLD_START_THRESHOLD) {
      // Cold start: use static multipliers against current mean
      mediumThreshold = STATIC_MEDIUM_MULTIPLIER * stats.mean;
      lowThreshold = STATIC_LOW_MULTIPLIER * stats.mean;
    } else {
      // Adaptive: mean + N * stddev
      // Floor stddev at 10% of mean to prevent zero-variance collapse
      const rawStddev = Math.sqrt(stats.variance);
      const stddev = Math.max(rawStddev, stats.mean * 0.1);
      mediumThreshold = stats.mean + ADAPTIVE_MEDIUM_STDDEV * stddev;
      lowThreshold = stats.mean + ADAPTIVE_LOW_STDDEV * stddev;
    }

    // Update EMA for mean
    const newMean = stats.mean * (1 - EMA_ALPHA) + durationMs * EMA_ALPHA;

    // Update EMA for variance: track (durationMs - mean)^2
    const deviation = durationMs - stats.mean;
    const newVariance = stats.variance * (1 - EMA_ALPHA) + EMA_ALPHA * deviation * deviation;

    this.domainStats.set(domain, {
      mean: newMean,
      variance: newVariance,
      count: stats.count + 1,
    });

    if (durationMs > mediumThreshold) {
      this._addSignal({
        type: 'slow-response',
        severity: 'medium',
        timestamp: Date.now(),
        details: `Response time ${durationMs}ms exceeds medium threshold ${Math.round(mediumThreshold)}ms`,
      });
    } else if (durationMs > lowThreshold) {
      this._addSignal({
        type: 'slow-response',
        severity: 'low',
        timestamp: Date.now(),
        details: `Response time ${durationMs}ms exceeds low threshold ${Math.round(lowThreshold)}ms`,
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
    const recentSignals = this.signals.filter((s) => s.timestamp >= windowStart);

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

    const shouldPause =
      hasCritical ||
      highSignalCount >= this.highSignalThreshold ||
      threatLevel >= this.pauseThreatThreshold;

    let reason = '';
    if (shouldPause) {
      if (hasCritical) {
        const critical = recentSignals.find((s) => s.severity === 'critical');
        reason = `Critical signal detected: ${critical?.type} (${critical?.details})`;
      } else if (highSignalCount >= this.highSignalThreshold) {
        const windowMinutes = Math.round(this.windowMs / 60000);
        reason = `High threat detected: ${highSignalCount} high-severity signals in ${windowMinutes} minutes`;
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
    this.domainStats.clear();
    logger.info('[SignalDetector] Signals and baselines cleared');
  }

  /**
   * Get current metrics for debugging
   */
  getMetrics(): object {
    return {
      signalCount: this.signals.length,
      threatLevel: this.assess().threatLevel,
      domainStats: Object.fromEntries(this.domainStats),
    };
  }

  private _addSignal(signal: Signal): void {
    this.signals.push(signal);
    logger.debug(`[SignalDetector] Signal recorded: ${signal.type} (${signal.severity})`, {
      details: signal.details,
    });
    this._evictOldSignals();
  }

  private _evictOldSignals(): void {
    const now = Date.now();
    const expiry = now - 30 * 60 * 1000; // Keep signals for 30 minutes for context, even if assessment window is shorter
    this.signals = this.signals.filter((s) => s.timestamp > expiry);

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
