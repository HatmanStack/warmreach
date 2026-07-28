import { logger } from '#utils/logger.js';

/**
 * Free-form structured-logging bag. Callers attach whatever is useful for the
 * log line; nothing here is read by name, so `unknown` values are correct
 * rather than a cop-out.
 */
type LogContext = Record<string, unknown>;

/** Per-outcome connection counters. */
export interface ConnectionCounters {
  processed: number;
  skipped: number;
  errors: number;
}

/** The outcome vocabulary `recordConnection` callers use. */
export type ConnectionOutcome = 'processed' | 'skipped' | 'error';

/**
 * Outcome name -> counter name. `error` and `errors` differ, and the counters
 * used to be indexed by the raw outcome string: `connections['error']++` on an
 * absent key set it to NaN and left `connections.errors` at zero, so failed
 * connections were never counted. The map makes the mismatch explicit and the
 * lookup total.
 */
const COUNTER_BY_OUTCOME: Record<ConnectionOutcome, keyof ConnectionCounters> = {
  processed: 'processed',
  skipped: 'skipped',
  error: 'errors',
};

/** Aggregate metrics tracked by {@link ProfileInitMonitor}. */
export interface ProfileInitMetrics {
  requests: {
    total: number;
    successful: number;
    failed: number;
    healing: number;
  };
  connections: ConnectionCounters;
  performance: {
    averageRequestDuration: number;
    averageConnectionProcessingTime: number;
    totalProcessingTime: number;
  };
  errors: {
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    recoverableCount: number;
    nonRecoverableCount: number;
  };
  healing: {
    totalHealingAttempts: number;
    successfulHealings: number;
    failedHealings: number;
    averageRecursionCount: number;
  };
}

/** In-flight request bookkeeping, dropped once the request settles. */
interface ActiveRequest {
  requestId: string;
  startTime: number;
  context: LogContext;
  connections: ConnectionCounters;
  errors: unknown[];
  healingAttempts: number;
}

/** The processing counts {@link ProfileInitMonitor.recordSuccess} reads. */
interface RequestResult {
  data?: {
    processed?: number;
    skipped?: number;
    errors?: number;
  };
}

/** The categorized-error fields the monitor reads off a failure. */
interface MonitorErrorDetails {
  type?: string;
  category?: string;
  isRecoverable?: boolean;
}

/** The healing fields the monitor reads off a heal attempt. */
interface HealingContext {
  recursionCount?: number;
  healPhase?: string | null;
  healReason?: string | null;
}

/** A frequency-ranked error signature. */
interface ErrorPattern {
  pattern: string;
  count: number;
}

/** {@link ProfileInitMetrics} plus the derived fields computed on read. */
export interface ProfileInitMetricsSnapshot extends ProfileInitMetrics {
  activeRequests: number;
  successRate: number | string;
  failureRate: number | string;
  healingSuccessRate: number | string;
  topErrorPatterns: ErrorPattern[];
  timestamp: string;
}

/**
 * Profile Initialization Monitoring Utility
 * Tracks metrics, performance, and error patterns for profile initialization
 */
class ProfileInitMonitor {
  metrics: ProfileInitMetrics;
  activeRequests: Map<string, ActiveRequest> = new Map();
  errorPatterns: Map<string, number> = new Map();

  constructor() {
    this.metrics = {
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        healing: 0,
      },
      connections: {
        processed: 0,
        skipped: 0,
        errors: 0,
      },
      performance: {
        averageRequestDuration: 0,
        averageConnectionProcessingTime: 0,
        totalProcessingTime: 0,
      },
      errors: {
        byType: {},
        byCategory: {},
        recoverableCount: 0,
        nonRecoverableCount: 0,
      },
      healing: {
        totalHealingAttempts: 0,
        successfulHealings: 0,
        failedHealings: 0,
        averageRecursionCount: 0,
      },
    };

    this.activeRequests = new Map();
    this.errorPatterns = new Map();
  }

  /**
   * Start tracking a new profile initialization request
   * @param {string} requestId - Unique request identifier
   * @param {Object} context - Request context
   */
  startRequest(requestId: string, context: LogContext = {}) {
    const requestData = {
      requestId,
      startTime: Date.now(),
      context,
      connections: {
        processed: 0,
        skipped: 0,
        errors: 0,
      },
      errors: [],
      healingAttempts: 0,
    };

    this.activeRequests.set(requestId, requestData);
    this.metrics.requests.total++;

    logger.info('Profile init monitoring: Request started', {
      requestId,
      totalRequests: this.metrics.requests.total,
      activeRequests: this.activeRequests.size,
      context,
    });
  }

  /**
   * Record successful request completion
   * @param {string} requestId - Request identifier
   * @param {Object} result - Request result
   */
  recordSuccess(requestId: string, result: RequestResult = {}) {
    const requestData = this.activeRequests.get(requestId);
    if (!requestData) {
      logger.warn('Profile init monitoring: Unknown request ID for success', { requestId });
      return;
    }

    const duration = Date.now() - requestData.startTime;
    this.metrics.requests.successful++;

    // Update connection metrics
    if (result.data) {
      this.metrics.connections.processed += result.data.processed || 0;
      this.metrics.connections.skipped += result.data.skipped || 0;
      this.metrics.connections.errors += result.data.errors || 0;
    }

    // Update performance metrics
    this._updatePerformanceMetrics(duration);

    logger.info('Profile init monitoring: Request completed successfully', {
      requestId,
      duration,
      processed: result.data?.processed || 0,
      skipped: result.data?.skipped || 0,
      errors: result.data?.errors || 0,
      successRate: this._calculateSuccessRate(),
      averageDuration: this.metrics.performance.averageRequestDuration,
    });

    this.activeRequests.delete(requestId);
  }

  /**
   * Record request failure
   * @param {string} requestId - Request identifier
   * @param {Error} error - Error that occurred
   * @param {Object} errorDetails - Categorized error details
   */
  recordFailure(requestId: string, error: Error, errorDetails: MonitorErrorDetails = {}) {
    const requestData = this.activeRequests.get(requestId);
    if (!requestData) {
      logger.warn('Profile init monitoring: Unknown request ID for failure', { requestId });
      return;
    }

    const duration = Date.now() - requestData.startTime;
    this.metrics.requests.failed++;

    // Track error patterns
    this._trackErrorPattern(error, errorDetails);

    // Update error metrics
    const errorType = errorDetails.type || 'UnknownError';
    const errorCategory = errorDetails.category || 'unknown';

    this.metrics.errors.byType[errorType] = (this.metrics.errors.byType[errorType] || 0) + 1;
    this.metrics.errors.byCategory[errorCategory] =
      (this.metrics.errors.byCategory[errorCategory] || 0) + 1;

    if (errorDetails.isRecoverable) {
      this.metrics.errors.recoverableCount++;
    } else {
      this.metrics.errors.nonRecoverableCount++;
    }

    logger.error('Profile init monitoring: Request failed', {
      requestId,
      duration,
      errorType,
      errorCategory,
      isRecoverable: errorDetails.isRecoverable,
      message: error.message,
      totalFailures: this.metrics.requests.failed,
      failureRate: this._calculateFailureRate(),
      errorPatterns: this._getTopErrorPatterns(),
    });

    this.activeRequests.delete(requestId);
  }

  /**
   * Record healing attempt
   * @param {string} requestId - Request identifier
   * @param {Object} healingContext - Healing context
   */
  recordHealing(requestId: string, healingContext: HealingContext = {}) {
    const requestData = this.activeRequests.get(requestId);
    if (requestData) {
      requestData.healingAttempts++;
    }

    this.metrics.requests.healing++;
    this.metrics.healing.totalHealingAttempts++;

    const recursionCount = healingContext.recursionCount || 0;
    this._updateAverageRecursionCount(recursionCount);

    logger.info('Profile init monitoring: Healing initiated', {
      requestId,
      recursionCount,
      healPhase: healingContext.healPhase,
      healReason: healingContext.healReason,
      totalHealingAttempts: this.metrics.healing.totalHealingAttempts,
      averageRecursionCount: this.metrics.healing.averageRecursionCount,
    });
  }

  /**
   * Record connection processing metrics
   * @param {string} requestId - Request identifier
   * @param {string} profileId - Connection profile ID
   * @param status - Processing outcome (processed, skipped, error)
   * @param duration - Processing duration
   * @param details - Additional details
   */
  recordConnection(
    requestId: string,
    profileId: string,
    status: ConnectionOutcome,
    duration: number,
    details: LogContext = {}
  ) {
    const counter = COUNTER_BY_OUTCOME[status];
    const requestData = this.activeRequests.get(requestId);
    if (requestData) {
      requestData.connections[counter]++;
    }

    // Update global connection metrics
    this.metrics.connections[counter]++;

    // Update average connection processing time
    if (status === 'processed' && duration) {
      this._updateConnectionProcessingTime(duration);
    }

    logger.debug('Profile init monitoring: Connection processed', {
      requestId,
      profileId: profileId.substring(0, 8) + '...',
      status,
      duration,
      totalProcessed: this.metrics.connections.processed,
      totalSkipped: this.metrics.connections.skipped,
      totalErrors: this.metrics.connections.errors,
      details,
    });
  }

  /**
   * Get current monitoring metrics
   * @returns {Object} Current metrics
   */
  getMetrics(): ProfileInitMetricsSnapshot {
    return {
      ...this.metrics,
      activeRequests: this.activeRequests.size,
      successRate: this._calculateSuccessRate(),
      failureRate: this._calculateFailureRate(),
      healingSuccessRate: this._calculateHealingSuccessRate(),
      topErrorPatterns: this._getTopErrorPatterns(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Log periodic monitoring summary
   */
  logSummary(): void {
    const metrics = this.getMetrics();

    logger.info('Profile init monitoring summary', {
      requests: metrics.requests,
      connections: metrics.connections,
      performance: {
        averageRequestDuration: metrics.performance.averageRequestDuration,
        averageConnectionProcessingTime: metrics.performance.averageConnectionProcessingTime,
      },
      errorSummary: {
        totalErrors: metrics.errors.recoverableCount + metrics.errors.nonRecoverableCount,
        recoverableErrors: metrics.errors.recoverableCount,
        nonRecoverableErrors: metrics.errors.nonRecoverableCount,
        topErrorTypes: Object.entries(metrics.errors.byType)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 5),
      },
      healing: metrics.healing,
      successRate: metrics.successRate,
      failureRate: metrics.failureRate,
      activeRequests: metrics.activeRequests,
    });
  }

  /**
   * Track error patterns for analysis
   * @private
   */
  _trackErrorPattern(_error: Error, errorDetails: MonitorErrorDetails): void {
    const pattern = `${errorDetails.type || 'Unknown'}:${errorDetails.category || 'unknown'}`;
    const count = this.errorPatterns.get(pattern) || 0;
    this.errorPatterns.set(pattern, count + 1);
  }

  /**
   * Update performance metrics
   * @private
   */
  _updatePerformanceMetrics(duration: number): void {
    const totalRequests = this.metrics.requests.successful + this.metrics.requests.failed;
    const currentTotal = this.metrics.performance.averageRequestDuration * (totalRequests - 1);
    this.metrics.performance.averageRequestDuration = (currentTotal + duration) / totalRequests;
    this.metrics.performance.totalProcessingTime += duration;
  }

  /**
   * Update connection processing time metrics
   * @private
   */
  _updateConnectionProcessingTime(duration: number): void {
    const totalProcessed = this.metrics.connections.processed;
    const currentTotal =
      this.metrics.performance.averageConnectionProcessingTime * (totalProcessed - 1);
    this.metrics.performance.averageConnectionProcessingTime =
      (currentTotal + duration) / totalProcessed;
  }

  /**
   * Update average recursion count for healing
   * @private
   */
  _updateAverageRecursionCount(recursionCount: number): void {
    const totalAttempts = this.metrics.healing.totalHealingAttempts;
    const currentTotal = this.metrics.healing.averageRecursionCount * (totalAttempts - 1);
    this.metrics.healing.averageRecursionCount = (currentTotal + recursionCount) / totalAttempts;
  }

  /**
   * Calculate success rate
   * @private
   */
  _calculateSuccessRate(): number | string {
    const total = this.metrics.requests.successful + this.metrics.requests.failed;
    return total > 0 ? ((this.metrics.requests.successful / total) * 100).toFixed(2) : 0;
  }

  /**
   * Calculate failure rate
   * @private
   */
  _calculateFailureRate(): number | string {
    const total = this.metrics.requests.successful + this.metrics.requests.failed;
    return total > 0 ? ((this.metrics.requests.failed / total) * 100).toFixed(2) : 0;
  }

  /**
   * Calculate healing success rate
   * @private
   */
  _calculateHealingSuccessRate(): number | string {
    const total = this.metrics.healing.successfulHealings + this.metrics.healing.failedHealings;
    return total > 0 ? ((this.metrics.healing.successfulHealings / total) * 100).toFixed(2) : 0;
  }

  /**
   * Get top error patterns
   * @private
   */
  _getTopErrorPatterns(): ErrorPattern[] {
    return Array.from(this.errorPatterns.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([pattern, count]) => ({ pattern, count }));
  }
}

// Create singleton instance
export const profileInitMonitor = new ProfileInitMonitor();

// Interval reference for cleanup
let summaryIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic monitoring summary logging
 * Safe to call multiple times - will not create duplicate intervals
 */
function startMonitoring(): void {
  if (!summaryIntervalId) {
    summaryIntervalId = setInterval(
      () => {
        profileInitMonitor.logSummary();
      },
      5 * 60 * 1000
    );
    logger.info('Profile init monitoring started');
  }
}

/**
 * Stop periodic monitoring summary logging
 * Should be called during graceful shutdown to prevent memory leaks
 */
export function stopMonitoring() {
  if (summaryIntervalId) {
    clearInterval(summaryIntervalId);
    summaryIntervalId = null;
    logger.info('Profile init monitoring stopped');
  }
}

// Auto-start monitoring on module load (maintains existing behavior)
startMonitoring();
