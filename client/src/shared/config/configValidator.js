import { logger } from '#utils/logger.js';
import config from '../config/index.js';

/**
 * Configuration Validator - Validates LinkedIn interaction configuration
 * Implements requirement 4.4 for configuration validation
 */
export class ConfigValidator {
  /**
   * Validation rules for LinkedIn interaction configuration
   */
  static validationRules = {
    // Session Management
    sessionTimeout: { min: 300000, max: 7200000 }, // 5 minutes to 2 hours
    sessionHealthCheckInterval: { min: 60000, max: 600000 }, // 1 to 10 minutes
    maxSessionErrors: { min: 1, max: 10 },
    sessionRecoveryTimeout: { min: 10000, max: 300000 }, // 10 seconds to 5 minutes

    // Concurrency Control
    maxConcurrentInteractions: { min: 1, max: 10 },
    maxConcurrentSessions: { min: 1, max: 3 },
    interactionQueueSize: { min: 10, max: 1000 },

    // Rate Limiting
    rateLimitWindow: { min: 10000, max: 3600000 }, // 10 seconds to 1 hour
    rateLimitMax: { min: 1, max: 100 },
    dailyInteractionLimit: { min: 10, max: 2000 },
    hourlyInteractionLimit: { min: 5, max: 500 },

    // Retry Configuration
    retryAttempts: { min: 1, max: 10 },
    retryBaseDelay: { min: 100, max: 10000 }, // 100ms to 10 seconds
    retryMaxDelay: { min: 1000, max: 1800000 }, // 1 second to 30 minutes
    retryJitterFactor: { min: 0, max: 1 },

    // Human Behavior
    humanDelayMin: { min: 500, max: 5000 },
    humanDelayMax: { min: 1000, max: 10000 },
    actionsPerMinute: { min: 1, max: 30 },
    actionsPerHour: { min: 10, max: 1000 },

    // Typing Simulation
    typingSpeedMin: { min: 50, max: 200 },
    typingSpeedMax: { min: 80, max: 300 },
    typingPauseChance: { min: 0, max: 1 },
    typingPauseMin: { min: 100, max: 2000 },
    typingPauseMax: { min: 500, max: 5000 },

    // Content Limits
    maxMessageLength: { min: 1000, max: 10000 },
    maxPostLength: { min: 100, max: 5000 },
    maxConnectionMessageLength: { min: 50, max: 500 },

    // Timeouts
    navigationTimeout: { min: 5000, max: 120000 }, // 5 seconds to 2 minutes
    elementWaitTimeout: { min: 1000, max: 60000 }, // 1 second to 1 minute
    messageComposeTimeout: { min: 5000, max: 60000 },
    postCreationTimeout: { min: 10000, max: 120000 },
    connectionRequestTimeout: { min: 5000, max: 60000 },
  };

  /**
   * Validate all LinkedIn interaction configuration
   * @returns {Object} Validation result with errors and warnings
   */
  static validateConfiguration() {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      recommendations: [],
    };

    const linkedinConfig = config.linkedinInteractions;

    // Validate numeric ranges
    this.validateNumericRanges(linkedinConfig, result);

    // Validate logical consistency
    this.validateLogicalConsistency(linkedinConfig, result);

    // Validate feature flags
    this.validateFeatureFlags(linkedinConfig, result);

    // Validate environment-specific settings
    this.validateEnvironmentSettings(linkedinConfig, result);

    // Generate recommendations
    this.generateRecommendations(linkedinConfig, result);

    // Log validation results
    this.logValidationResults(result);

    return result;
  }

  /**
   * Validate numeric configuration values are within acceptable ranges
   */
  static validateNumericRanges(linkedinConfig, result) {
    for (const [key, rule] of Object.entries(this.validationRules)) {
      const value = linkedinConfig[key];

      if (value === undefined || value === null) {
        result.warnings.push(`Configuration '${key}' is not set, using default value`);
        continue;
      }

      if (typeof value !== 'number' || isNaN(value)) {
        result.errors.push(`Configuration '${key}' must be a valid number, got: ${value}`);
        result.isValid = false;
        continue;
      }

      if (value < rule.min) {
        result.errors.push(
          `Configuration '${key}' (${value}) is below minimum value (${rule.min})`
        );
        result.isValid = false;
      }

      if (value > rule.max) {
        result.errors.push(`Configuration '${key}' (${value}) exceeds maximum value (${rule.max})`);
        result.isValid = false;
      }
    }
  }

  /**
   * Validate logical consistency between related configuration values
   */
  static validateLogicalConsistency(linkedinConfig, result) {
    // Human delay consistency
    if (linkedinConfig.humanDelayMin >= linkedinConfig.humanDelayMax) {
      result.errors.push('humanDelayMin must be less than humanDelayMax');
      result.isValid = false;
    }

    // Typing speed consistency
    if (linkedinConfig.typingSpeedMin >= linkedinConfig.typingSpeedMax) {
      result.errors.push('typingSpeedMin must be less than typingSpeedMax');
      result.isValid = false;
    }

    // Typing pause consistency
    if (linkedinConfig.typingPauseMin >= linkedinConfig.typingPauseMax) {
      result.errors.push('typingPauseMin must be less than typingPauseMax');
      result.isValid = false;
    }

    // Cooldown consistency
    if (linkedinConfig.cooldownMinDuration >= linkedinConfig.cooldownMaxDuration) {
      result.errors.push('cooldownMinDuration must be less than cooldownMaxDuration');
      result.isValid = false;
    }

    // Retry delay consistency
    if (linkedinConfig.retryBaseDelay >= linkedinConfig.retryMaxDelay) {
      result.errors.push('retryBaseDelay must be less than retryMaxDelay');
      result.isValid = false;
    }

    // Rate limiting consistency
    if (linkedinConfig.hourlyInteractionLimit > linkedinConfig.dailyInteractionLimit) {
      result.warnings.push(
        'hourlyInteractionLimit is higher than dailyInteractionLimit, which may cause issues'
      );
    }

    // Actions per time period consistency
    if (linkedinConfig.actionsPerMinute * 60 > linkedinConfig.actionsPerHour) {
      result.warnings.push(
        'actionsPerMinute * 60 exceeds actionsPerHour, which may cause rate limiting'
      );
    }

    // Session timeout vs health check interval
    if (linkedinConfig.sessionHealthCheckInterval >= linkedinConfig.sessionTimeout) {
      result.warnings.push('sessionHealthCheckInterval should be less than sessionTimeout');
    }
  }

  /**
   * Validate feature flag configurations
   */
  static validateFeatureFlags(linkedinConfig, result) {
    const featureFlags = [
      'enableMessageSending',
      'enableConnectionRequests',
      'enablePostCreation',
      'enableHumanBehavior',
      'enableSuspiciousActivityDetection',
    ];

    let enabledFeatures = 0;
    for (const flag of featureFlags) {
      if (linkedinConfig[flag] === true) {
        enabledFeatures++;
      }
    }

    if (enabledFeatures === 0) {
      result.warnings.push('All LinkedIn interaction features are disabled');
    }

    // Validate dependent features
    if (linkedinConfig.enableSuspiciousActivityDetection && !linkedinConfig.enableHumanBehavior) {
      result.warnings.push(
        'Suspicious activity detection works best with human behavior simulation enabled'
      );
    }
  }

  /**
   * Validate environment-specific settings
   */
  static validateEnvironmentSettings(linkedinConfig, result) {
    const isProduction = config.nodeEnv === 'production';
    const isDevelopment = config.nodeEnv === 'development';

    if (isProduction) {
      // Production-specific validations
      if (linkedinConfig.debugMode) {
        result.warnings.push('Debug mode is enabled in production environment');
      }

      if (linkedinConfig.verboseLogging) {
        result.warnings.push('Verbose logging is enabled in production environment');
      }

      if (linkedinConfig.screenshotOnError) {
        result.warnings.push(
          'Screenshot on error is enabled in production (may impact performance)'
        );
      }

      // Stricter limits for production
      if (linkedinConfig.maxConcurrentInteractions > 5) {
        result.warnings.push(
          'High concurrent interaction limit in production may trigger rate limiting'
        );
      }

      if (linkedinConfig.actionsPerMinute > 10) {
        result.warnings.push('High actions per minute in production may appear suspicious');
      }
    }

    if (isDevelopment) {
      // Development-specific recommendations
      if (!linkedinConfig.debugMode) {
        result.recommendations.push('Consider enabling debug mode for development');
      }

      if (!linkedinConfig.screenshotOnError) {
        result.recommendations.push('Consider enabling screenshots on error for debugging');
      }
    }
  }

  /**
   * Generate configuration recommendations
   */
  static generateRecommendations(linkedinConfig, result) {
    // Performance recommendations
    if (linkedinConfig.sessionTimeout < 1800000) {
      // 30 minutes
      result.recommendations.push('Consider increasing sessionTimeout for better performance');
    }

    if (linkedinConfig.maxConcurrentInteractions === 1) {
      result.recommendations.push(
        'Consider allowing more concurrent interactions for better throughput'
      );
    }

    // Security recommendations
    if (linkedinConfig.rateLimitMax > 20) {
      result.recommendations.push('Consider lowering rate limit to avoid LinkedIn detection');
    }

    if (linkedinConfig.humanDelayMin < 2000) {
      result.recommendations.push(
        'Consider increasing minimum human delay for more realistic behavior'
      );
    }

    // Reliability recommendations
    if (linkedinConfig.retryAttempts < 3) {
      result.recommendations.push('Consider increasing retry attempts for better reliability');
    }

    if (!linkedinConfig.auditLoggingEnabled) {
      result.recommendations.push('Consider enabling audit logging for compliance and debugging');
    }
  }

  /**
   * Log validation results
   */
  static logValidationResults(result) {
    if (result.isValid) {
      logger.info('LinkedIn interaction configuration validation passed', {
        warningCount: result.warnings.length,
        recommendationCount: result.recommendations.length,
      });
    } else {
      logger.error('LinkedIn interaction configuration validation failed', {
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
      });
    }

    // Log errors
    result.errors.forEach((error) => {
      logger.error('Configuration error:', error);
    });

    // Log warnings
    result.warnings.forEach((warning) => {
      logger.warn('Configuration warning:', warning);
    });

    // Log recommendations in development
    if (config.nodeEnv === 'development') {
      result.recommendations.forEach((recommendation) => {
        logger.info('Configuration recommendation:', recommendation);
      });
    }
  }

  /**
   * Get configuration summary for monitoring
   */
  static getConfigurationSummary() {
    const linkedinConfig = config.linkedinInteractions;

    return {
      environment: config.nodeEnv,
      sessionTimeout: linkedinConfig.sessionTimeout,
      maxConcurrentInteractions: linkedinConfig.maxConcurrentInteractions,
      rateLimitMax: linkedinConfig.rateLimitMax,
      retryAttempts: linkedinConfig.retryAttempts,
      humanBehaviorEnabled: linkedinConfig.enableHumanBehavior,
      suspiciousActivityDetectionEnabled: linkedinConfig.enableSuspiciousActivityDetection,
      auditLoggingEnabled: linkedinConfig.auditLoggingEnabled,
      debugMode: linkedinConfig.debugMode,
      featuresEnabled: {
        messageSending: linkedinConfig.enableMessageSending,
        connectionRequests: linkedinConfig.enableConnectionRequests,
        postCreation: linkedinConfig.enablePostCreation,
      },
    };
  }

  /**
   * Validate configuration on startup
   */
  static validateOnStartup() {
    logger.info('Validating LinkedIn interaction configuration...');

    const validation = this.validateConfiguration();

    if (!validation.isValid) {
      logger.error('Configuration validation failed, application may not work correctly');

      // In production, throw error instead of abrupt termination
      if (config.nodeEnv === 'production') {
        throw new Error('Invalid configuration in production');
      }
    }

    // Log configuration summary
    const summary = this.getConfigurationSummary();
    logger.info('LinkedIn interaction configuration summary', summary);

    return validation;
  }
}

export default ConfigValidator;
