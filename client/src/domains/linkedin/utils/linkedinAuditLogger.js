import { logger } from '#utils/logger.js';

/**
 * LinkedIn Audit Logger - Comprehensive audit trail for LinkedIn interactions
 * Implements requirement 7.1, 7.2, 7.3 for audit trails and monitoring
 */
export class LinkedInAuditLogger {
  /**
   * Log interaction attempt
   * @param {string} operation - Operation being attempted
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logInteractionAttempt(operation, context, requestId) {
    const auditData = {
      eventType: 'INTERACTION_ATTEMPT',
      operation,
      requestId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      context: {
        ...context,
        // Remove sensitive data
        messageContent: context.messageContent ? '[REDACTED]' : undefined,
        connectionMessage: context.connectionMessage ? '[REDACTED]' : undefined,
        content: context.content ? '[REDACTED]' : undefined,
      },
    };

    logger.info('LinkedIn interaction attempt', auditData);
  }

  /**
   * Log successful interaction
   * @param {string} operation - Operation that succeeded
   * @param {Object} result - Operation result
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logInteractionSuccess(operation, result, context, requestId) {
    const auditData = {
      eventType: 'INTERACTION_SUCCESS',
      operation,
      requestId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      result: {
        ...result,
        // Include relevant metrics
        duration: context.duration,
        attemptCount: context.attemptCount || 1,
      },
      context: {
        profileId: context.profileId,
        recipientProfileId: context.recipientProfileId,
        contentLength: context.contentLength,
        hasMedia: context.hasMedia,
        hasMessage: context.hasMessage,
      },
    };

    logger.info('LinkedIn interaction success', auditData);
  }

  /**
   * Log failed interaction
   * @param {string} operation - Operation that failed
   * @param {Error} error - Error that occurred
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logInteractionFailure(operation, error, context, requestId) {
    const auditData = {
      eventType: 'INTERACTION_FAILURE',
      operation,
      requestId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        category: context.errorCategory,
        code: context.errorCode,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      context: {
        profileId: context.profileId,
        recipientProfileId: context.recipientProfileId,
        attemptCount: context.attemptCount || 1,
        duration: context.duration,
      },
    };

    logger.error('LinkedIn interaction failure', auditData);
  }

  /**
   * Log rate limiting detection
   * @param {string} operation - Operation that was rate limited
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logRateLimitDetected(operation, context, requestId) {
    const auditData = {
      eventType: 'RATE_LIMIT_DETECTED',
      operation,
      requestId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      rateLimitInfo: {
        retryAfter: context.retryAfter,
        attemptCount: context.attemptCount,
        recentInteractions: context.recentInteractions,
      },
    };

    logger.warn('LinkedIn rate limiting detected', auditData);
  }

  /**
   * Log browser session events
   * @param {string} eventType - Type of session event
   * @param {Object} sessionInfo - Session information
   * @param {string} requestId - Unique request identifier
   */
  static logSessionEvent(eventType, sessionInfo, requestId = null) {
    const auditData = {
      eventType: `SESSION_${eventType.toUpperCase()}`,
      requestId,
      timestamp: new Date().toISOString(),
      sessionInfo: {
        isActive: sessionInfo.isActive,
        isHealthy: sessionInfo.isHealthy,
        isAuthenticated: sessionInfo.isAuthenticated,
        sessionAge: sessionInfo.sessionAge,
        errorCount: sessionInfo.errorCount,
        memoryUsage: sessionInfo.memoryUsage,
      },
    };

    const logLevel = eventType === 'crash' || eventType === 'error' ? 'error' : 'info';
    logger[logLevel](`LinkedIn session ${eventType}`, auditData);
  }

  /**
   * Log authentication events
   * @param {string} eventType - Type of authentication event
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logAuthenticationEvent(eventType, context, requestId) {
    const auditData = {
      eventType: `AUTH_${eventType.toUpperCase()}`,
      requestId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      authInfo: {
        jwtValid: context.jwtValid,
        linkedinAuthenticated: context.linkedinAuthenticated,
        sessionExpired: context.sessionExpired,
      },
    };

    const logLevel = eventType === 'failure' || eventType === 'expired' ? 'warn' : 'info';
    logger[logLevel](`LinkedIn authentication ${eventType}`, auditData);
  }

  /**
   * Log suspicious activity detection
   * @param {string} activityType - Type of suspicious activity
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logSuspiciousActivity(activityType, context, requestId) {
    const auditData = {
      eventType: 'SUSPICIOUS_ACTIVITY_DETECTED',
      activityType,
      requestId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      activityInfo: {
        interactionCount: context.interactionCount,
        timeWindow: context.timeWindow,
        patterns: context.patterns,
        riskLevel: context.riskLevel,
      },
    };

    logger.warn('Suspicious activity detected', auditData);
  }

  /**
   * Log human behavior simulation events
   * @param {string} behaviorType - Type of behavior being simulated
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logHumanBehavior(behaviorType, context, requestId) {
    const auditData = {
      eventType: 'HUMAN_BEHAVIOR_SIMULATION',
      behaviorType,
      requestId,
      timestamp: new Date().toISOString(),
      behaviorInfo: {
        delay: context.delay,
        typingSpeed: context.typingSpeed,
        mouseMovement: context.mouseMovement,
        scrollPattern: context.scrollPattern,
      },
    };

    logger.debug('Human behavior simulation', auditData);
  }

  /**
   * Log recovery attempts
   * @param {string} recoveryType - Type of recovery being attempted
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logRecoveryAttempt(recoveryType, context, requestId) {
    const auditData = {
      eventType: 'RECOVERY_ATTEMPT',
      recoveryType,
      requestId,
      timestamp: new Date().toISOString(),
      recoveryInfo: {
        originalError: context.originalError,
        attemptCount: context.attemptCount,
        recoveryActions: context.recoveryActions,
        success: context.success,
      },
    };

    const logLevel = context.success ? 'info' : 'warn';
    logger[logLevel](`Recovery attempt ${context.success ? 'succeeded' : 'failed'}`, auditData);
  }

  /**
   * Generate interaction summary for reporting
   * @param {string} timeframe - Timeframe for summary (e.g., 'last_hour', 'last_day')
   * @returns {Object} Interaction summary
   */
  static generateInteractionSummary(timeframe = 'last_hour') {
    // This would typically query log storage for aggregated data
    // For now, return a placeholder structure
    const summary = {
      timeframe,
      generatedAt: new Date().toISOString(),
      metrics: {
        totalInteractions: 0,
        successfulInteractions: 0,
        failedInteractions: 0,
        rateLimitEvents: 0,
        sessionCrashes: 0,
        averageResponseTime: 0,
      },
      errorBreakdown: {
        authentication: 0,
        browser: 0,
        linkedin: 0,
        validation: 0,
        network: 0,
        system: 0,
      },
      topErrors: [],
      recommendations: [],
    };

    logger.info('Generated interaction summary', summary);
    return summary;
  }

  /**
   * Log performance metrics
   * @param {string} operation - Operation being measured
   * @param {number} duration - Duration in milliseconds
   * @param {Object} context - Context information
   * @param {string} requestId - Unique request identifier
   */
  static logPerformanceMetrics(operation, duration, context, requestId) {
    const auditData = {
      eventType: 'PERFORMANCE_METRICS',
      operation,
      requestId,
      timestamp: new Date().toISOString(),
      performance: {
        duration,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        browserMetrics: context.browserMetrics,
      },
    };

    // Log as warning if operation took too long
    const logLevel = duration > 30000 ? 'warn' : 'debug'; // 30 seconds threshold
    logger[logLevel]('Performance metrics', auditData);
  }
}

export default LinkedInAuditLogger;
