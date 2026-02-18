import { logger } from '#utils/logger.js';

/**
 * Profile Initialization Monitoring Utility
 * Tracks metrics, performance, and error patterns for profile initialization
 */
export class ProfileInitMonitor {
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
  startRequest(requestId, context = {}) {
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
  recordSuccess(requestId, result = {}) {
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
  recordFailure(requestId, error, errorDetails = {}) {
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
  recordHealing(requestId, healingContext = {}) {
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
   * @param {string} status - Processing status (processed, skipped, error)
   * @param {number} duration - Processing duration
   * @param {Object} details - Additional details
   */
  recordConnection(requestId, profileId, status, duration, details = {}) {
    const requestData = this.activeRequests.get(requestId);
    if (requestData) {
      requestData.connections[status]++;
    }

    // Update global connection metrics
    this.metrics.connections[status]++;

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
  getMetrics() {
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
  logSummary() {
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
          .sort(([, a], [, b]) => b - a)
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
  _trackErrorPattern(error, errorDetails) {
    const pattern = `${errorDetails.type || 'Unknown'}:${errorDetails.category || 'unknown'}`;
    const count = this.errorPatterns.get(pattern) || 0;
    this.errorPatterns.set(pattern, count + 1);
  }

  /**
   * Update performance metrics
   * @private
   */
  _updatePerformanceMetrics(duration) {
    const totalRequests = this.metrics.requests.successful + this.metrics.requests.failed;
    const currentTotal = this.metrics.performance.averageRequestDuration * (totalRequests - 1);
    this.metrics.performance.averageRequestDuration = (currentTotal + duration) / totalRequests;
    this.metrics.performance.totalProcessingTime += duration;
  }

  /**
   * Update connection processing time metrics
   * @private
   */
  _updateConnectionProcessingTime(duration) {
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
  _updateAverageRecursionCount(recursionCount) {
    const totalAttempts = this.metrics.healing.totalHealingAttempts;
    const currentTotal = this.metrics.healing.averageRecursionCount * (totalAttempts - 1);
    this.metrics.healing.averageRecursionCount = (currentTotal + recursionCount) / totalAttempts;
  }

  /**
   * Calculate success rate
   * @private
   */
  _calculateSuccessRate() {
    const total = this.metrics.requests.successful + this.metrics.requests.failed;
    return total > 0 ? ((this.metrics.requests.successful / total) * 100).toFixed(2) : 0;
  }

  /**
   * Calculate failure rate
   * @private
   */
  _calculateFailureRate() {
    const total = this.metrics.requests.successful + this.metrics.requests.failed;
    return total > 0 ? ((this.metrics.requests.failed / total) * 100).toFixed(2) : 0;
  }

  /**
   * Calculate healing success rate
   * @private
   */
  _calculateHealingSuccessRate() {
    const total = this.metrics.healing.successfulHealings + this.metrics.healing.failedHealings;
    return total > 0 ? ((this.metrics.healing.successfulHealings / total) * 100).toFixed(2) : 0;
  }

  /**
   * Get top error patterns
   * @private
   */
  _getTopErrorPatterns() {
    return Array.from(this.errorPatterns.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([pattern, count]) => ({ pattern, count }));
  }
}

// Create singleton instance
export const profileInitMonitor = new ProfileInitMonitor();

// Interval reference for cleanup
let summaryIntervalId = null;

/**
 * Start periodic monitoring summary logging
 * Safe to call multiple times - will not create duplicate intervals
 */
export function startMonitoring() {
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

export default ProfileInitMonitor;
