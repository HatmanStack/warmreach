import { logger } from '#utils/logger.js';
import { ConfigManager } from '#shared-config/configManager.js';
import ConfigValidator from './configValidator.js';

/**
 * Configuration Initializer - Handles startup configuration initialization
 * Implements requirement 4.4 for configuration setup
 */
export class ConfigInitializer {
  /**
   * Initialize configuration system on application startup
   * @returns {Promise<boolean>} Success status
   */
  static async initialize() {
    try {
      logger.info('Initializing LinkedIn interaction configuration system...');

      // Step 1: Validate configuration
      const validation = ConfigValidator.validateOnStartup();

      if (!validation.isValid) {
        logger.error('Configuration validation failed during startup', {
          errorCount: validation.errors.length,
          errors: validation.errors,
        });

        // In production, exit on invalid configuration
        if (process.env.NODE_ENV === 'production') {
          logger.error('Exiting due to invalid configuration in production environment');
          process.exit(1);
        }
      }

      // Step 2: Initialize configuration manager
      const configManager = ConfigManager.getInstance();

      // Step 3: Log configuration summary
      this.logConfigurationSummary(configManager);

      // Step 4: Set up configuration monitoring
      this.setupConfigurationMonitoring(configManager);

      // Step 5: Validate feature dependencies
      this.validateFeatureDependencies(configManager);

      logger.info('LinkedIn interaction configuration system initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize configuration system:', error);

      // In production, exit on initialization failure
      if (process.env.NODE_ENV === 'production') {
        logger.error('Exiting due to configuration initialization failure in production');
        process.exit(1);
      }

      return false;
    }
  }

  /**
   * Log comprehensive configuration summary
   * @param {ConfigManager} configManager - Configuration manager instance
   */
  static logConfigurationSummary(configManager) {
    const summary = {
      environment: configManager.getEnvironmentConfig(),
      features: {
        messageSending: configManager.isFeatureEnabled('messageSending'),
        connectionRequests: configManager.isFeatureEnabled('connectionRequests'),
        postCreation: configManager.isFeatureEnabled('postCreation'),
        humanBehavior: configManager.isFeatureEnabled('humanBehavior'),
        suspiciousActivityDetection: configManager.isFeatureEnabled('suspiciousActivityDetection'),
      },
      limits: {
        maxConcurrentInteractions: configManager.get('maxConcurrentInteractions'),
        rateLimitMax: configManager.get('rateLimitMax'),
        dailyInteractionLimit: configManager.get('dailyInteractionLimit'),
        hourlyInteractionLimit: configManager.get('hourlyInteractionLimit'),
      },
      timeouts: configManager.getTimeoutConfig(),
      monitoring: {
        auditLoggingEnabled: configManager.get('auditLoggingEnabled'),
        performanceLoggingEnabled: configManager.get('performanceLoggingEnabled'),
        debugMode: configManager.get('debugMode'),
      },
    };

    logger.info('LinkedIn interaction configuration summary', summary);
  }

  /**
   * Set up configuration monitoring and health checks
   * @param {ConfigManager} configManager - Configuration manager instance
   */
  static setupConfigurationMonitoring(configManager) {
    // Add configuration watcher for critical changes
    configManager.addConfigWatcher((event, data) => {
      if (event === 'validation') {
        if (!data.isValid) {
          logger.warn('Configuration validation failed during runtime', {
            errorCount: data.errors.length,
            errors: data.errors,
          });
        }
      }
    });

    // Set up periodic health checks
    setInterval(() => {
      const health = configManager.getHealthStatus();

      if (!health.isValid) {
        logger.warn('Configuration health check failed', health);
      } else {
        logger.debug('Configuration health check passed', health);
      }
    }, 600000); // 10 minutes

    logger.debug('Configuration monitoring and health checks initialized');
  }

  /**
   * Validate feature dependencies and warn about potential issues
   * @param {ConfigManager} configManager - Configuration manager instance
   */
  static validateFeatureDependencies(configManager) {
    const warnings = [];

    // Check if any features are enabled
    const enabledFeatures = ['messageSending', 'connectionRequests', 'postCreation'].filter(
      (feature) => configManager.isFeatureEnabled(feature)
    );

    if (enabledFeatures.length === 0) {
      warnings.push('No LinkedIn interaction features are enabled');
    }

    // Check human behavior dependency
    if (enabledFeatures.length > 0 && !configManager.isFeatureEnabled('humanBehavior')) {
      warnings.push(
        'Human behavior simulation is disabled but interaction features are enabled - this may trigger detection'
      );
    }

    // Check suspicious activity detection
    if (
      configManager.isFeatureEnabled('suspiciousActivityDetection') &&
      !configManager.isFeatureEnabled('humanBehavior')
    ) {
      warnings.push(
        'Suspicious activity detection is enabled but human behavior simulation is disabled'
      );
    }

    // Check rate limiting configuration
    const rateLimitConfig = configManager.getRateLimitConfig();
    if (rateLimitConfig.max > 20) {
      warnings.push('Rate limit is set high - this may trigger LinkedIn detection');
    }

    // Check concurrent interactions
    const maxConcurrent = configManager.get('maxConcurrentInteractions');
    if (maxConcurrent > 5) {
      warnings.push('High concurrent interaction limit may trigger rate limiting');
    }

    // Log warnings
    warnings.forEach((warning) => {
      logger.warn('Configuration dependency warning:', warning);
    });

    if (warnings.length === 0) {
      logger.info('All feature dependencies validated successfully');
    }
  }

  /**
   * Get initialization status for health checks
   * @returns {Object} Initialization status
   */
  static getInitializationStatus() {
    const configManager = ConfigManager.getInstance();

    return {
      initialized: true,
      timestamp: new Date().toISOString(),
      configurationValid: configManager.getLastValidation()?.isValid || false,
      featuresEnabled: [
        'messageSending',
        'connectionRequests',
        'postCreation',
        'humanBehavior',
        'suspiciousActivityDetection',
      ].filter((feature) => configManager.isFeatureEnabled(feature)),
      environment: process.env.NODE_ENV,
      healthStatus: configManager.getHealthStatus(),
    };
  }

  /**
   * Reinitialize configuration (for runtime updates)
   * @returns {Promise<boolean>} Success status
   */
  static async reinitialize() {
    logger.info('Reinitializing LinkedIn interaction configuration...');

    try {
      // Clear configuration cache
      const configManager = ConfigManager.getInstance();
      configManager.clearCache();

      // Revalidate configuration
      const validation = configManager.validateConfiguration();

      if (!validation.isValid) {
        logger.error('Configuration revalidation failed', {
          errorCount: validation.errors.length,
          errors: validation.errors,
        });
        return false;
      }

      // Log updated summary
      this.logConfigurationSummary(configManager);

      logger.info('Configuration reinitialization completed successfully');
      return true;
    } catch (error) {
      logger.error('Failed to reinitialize configuration:', error);
      return false;
    }
  }

  /**
   * Export configuration for backup or analysis
   * @returns {Object} Configuration export
   */
  static exportConfiguration() {
    const configManager = ConfigManager.getInstance();

    return {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      configuration: configManager.getAll(),
      validation: configManager.getLastValidation(),
      statistics: configManager.getStatistics(),
      healthStatus: configManager.getHealthStatus(),
    };
  }

  /**
   * Generate configuration report for monitoring
   * @returns {Object} Configuration report
   */
  static generateConfigurationReport() {
    const configManager = ConfigManager.getInstance();
    const validation = configManager.getLastValidation();

    return {
      reportTimestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      status: {
        initialized: true,
        valid: validation?.isValid || false,
        errorCount: validation?.errors?.length || 0,
        warningCount: validation?.warnings?.length || 0,
      },
      features: {
        messageSending: configManager.isFeatureEnabled('messageSending'),
        connectionRequests: configManager.isFeatureEnabled('connectionRequests'),
        postCreation: configManager.isFeatureEnabled('postCreation'),
        humanBehavior: configManager.isFeatureEnabled('humanBehavior'),
        suspiciousActivityDetection: configManager.isFeatureEnabled('suspiciousActivityDetection'),
      },
      limits: configManager.getRateLimitConfig(),
      performance: {
        sessionTimeout: configManager.get('sessionTimeout'),
        maxConcurrentInteractions: configManager.get('maxConcurrentInteractions'),
        retryAttempts: configManager.get('retryAttempts'),
      },
      monitoring: configManager.getMonitoringConfig(),
      recommendations: validation?.recommendations || [],
    };
  }
}

export default ConfigInitializer;
