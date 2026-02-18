import { logger } from '#utils/logger.js';
import config from '../config/index.js';
import ConfigValidator from './configValidator.js';
import ControlPlaneService from '../services/controlPlaneService.js';

/**
 * Configuration Manager - Manages LinkedIn interaction configuration
 * Implements requirement 4.4 for configuration management
 */
export class ConfigManager {
  static instance = null;
  static configCache = new Map();
  static lastValidation = null;
  static configWatchers = new Set();

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!this.instance) {
      this.instance = new ConfigManager();
    }
    return this.instance;
  }

  constructor() {
    this.config = config.linkedinInteractions;
    this.initializeConfiguration();
  }

  /**
   * Initialize configuration and validate
   */
  initializeConfiguration() {
    logger.info('Initializing LinkedIn interaction configuration manager');

    // Validate configuration on startup
    this.lastValidation = ConfigValidator.validateOnStartup();

    // Cache frequently accessed configuration values
    this.cacheFrequentlyUsedConfig();

    // Pre-load feature flags from control plane
    this._loadFeatureFlags();

    // Set up configuration monitoring
    this.setupConfigurationMonitoring();
  }

  /**
   * Pre-load feature flags from control plane into config cache.
   * Note: This is async fire-and-forget. Feature flags may not be available
   * immediately after startup — callers should handle missing flags gracefully
   * (isFeatureEnabled returns false for unknown flags by default).
   */
  _loadFeatureFlags() {
    const cpService = new ControlPlaneService();
    if (!cpService.isConfigured) return;

    cpService
      .getFeatureFlags()
      .then((flags) => {
        if (flags && flags.features) {
          for (const [key, value] of Object.entries(flags.features)) {
            ConfigManager.configCache.set(`featureFlags.${key}`, value);
          }
          logger.debug('Loaded control plane feature flags', { tier: flags.tier });
        }
      })
      .catch((err) => {
        logger.debug('Failed to pre-load feature flags', { error: err.message });
      });
  }

  /**
   * Cache frequently used configuration values for performance
   */
  cacheFrequentlyUsedConfig() {
    const frequentlyUsed = [
      'sessionTimeout',
      'maxConcurrentInteractions',
      'rateLimitMax',
      'rateLimitWindow',
      'retryAttempts',
      'humanDelayMin',
      'humanDelayMax',
      'navigationTimeout',
      'elementWaitTimeout',
    ];

    frequentlyUsed.forEach((key) => {
      ConfigManager.configCache.set(key, this.config[key]);
    });

    logger.debug('Cached frequently used configuration values', {
      cachedKeys: frequentlyUsed,
    });
  }

  /**
   * Set up configuration monitoring and health checks
   */
  setupConfigurationMonitoring() {
    // Periodic configuration validation
    setInterval(() => {
      this.validateConfiguration();
    }, 300000); // 5 minutes

    logger.debug('Configuration monitoring initialized');
  }

  /**
   * Get configuration value with caching
   * @param {string} key - Configuration key
   * @param {any} defaultValue - Default value if key not found
   * @returns {any} Configuration value
   */
  get(key, defaultValue = null) {
    // Check cache first for frequently used values
    if (ConfigManager.configCache.has(key)) {
      return ConfigManager.configCache.get(key);
    }

    // Get from main configuration
    const value = this.config[key];
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Override a configuration value at runtime.
   * Updates both the live config and the cache.
   * @param {string} key - Configuration key
   * @param {any} value - New value
   */
  setOverride(key, value) {
    this.config[key] = value;
    ConfigManager.configCache.set(key, value);
  }

  /**
   * Get all configuration values
   * @returns {Object} All LinkedIn interaction configuration
   */
  getAll() {
    return { ...this.config };
  }

  /**
   * Get configuration for specific operation type
   * @param {string} operationType - Type of operation (sendMessage, addConnection, createPost)
   * @returns {Object} Operation-specific configuration
   */
  getOperationConfig(operationType) {
    const baseConfig = {
      retryAttempts: this.get('retryAttempts'),
      retryBaseDelay: this.get('retryBaseDelay'),
      retryMaxDelay: this.get('retryMaxDelay'),
      humanDelayMin: this.get('humanDelayMin'),
      humanDelayMax: this.get('humanDelayMax'),
      enableHumanBehavior: this.get('enableHumanBehavior'),
    };

    switch (operationType) {
      case 'sendMessage':
        return {
          ...baseConfig,
          enabled: this.get('enableMessageSending'),
          timeout: this.get('messageComposeTimeout'),
          maxContentLength: this.get('maxMessageLength'),
        };

      case 'addConnection':
        return {
          ...baseConfig,
          enabled: this.get('enableConnectionRequests'),
          timeout: this.get('connectionRequestTimeout'),
          maxMessageLength: this.get('maxConnectionMessageLength'),
        };

      case 'createPost':
        return {
          ...baseConfig,
          enabled: this.get('enablePostCreation'),
          timeout: this.get('postCreationTimeout'),
          maxContentLength: this.get('maxPostLength'),
        };

      default:
        return baseConfig;
    }
  }

  /**
   * Get rate limiting configuration
   * @returns {Object} Rate limiting configuration
   */
  getRateLimitConfig() {
    return {
      window: this.get('rateLimitWindow'),
      max: this.get('rateLimitMax'),
      dailyLimit: this.get('dailyInteractionLimit'),
      hourlyLimit: this.get('hourlyInteractionLimit'),
      suspiciousActivityThreshold: this.get('suspiciousActivityThreshold'),
      suspiciousActivityWindow: this.get('suspiciousActivityWindow'),
    };
  }

  /**
   * Get human behavior simulation configuration
   * @returns {Object} Human behavior configuration
   */
  getHumanBehaviorConfig() {
    return {
      enabled: this.get('enableHumanBehavior'),
      delayMin: this.get('humanDelayMin'),
      delayMax: this.get('humanDelayMax'),
      actionsPerMinute: this.get('actionsPerMinute'),
      actionsPerHour: this.get('actionsPerHour'),
      typingSpeedMin: this.get('typingSpeedMin'),
      typingSpeedMax: this.get('typingSpeedMax'),
      typingPauseChance: this.get('typingPauseChance'),
      typingPauseMin: this.get('typingPauseMin'),
      typingPauseMax: this.get('typingPauseMax'),
      mouseMovementSteps: this.get('mouseMovementSteps'),
      mouseMovementDelay: this.get('mouseMovementDelay'),
      scrollStepSize: this.get('scrollStepSize'),
      scrollDelay: this.get('scrollDelay'),
    };
  }

  /**
   * Get session management configuration
   * @returns {Object} Session management configuration
   */
  getSessionConfig() {
    return {
      timeout: this.get('sessionTimeout'),
      healthCheckInterval: this.get('sessionHealthCheckInterval'),
      maxErrors: this.get('maxSessionErrors'),
      recoveryTimeout: this.get('sessionRecoveryTimeout'),
      maxConcurrentSessions: this.get('maxConcurrentSessions'),
      browserIdleTimeout: this.get('browserIdleTimeout'),
    };
  }

  /**
   * Get timeout configuration for different operations
   * @returns {Object} Timeout configuration
   */
  getTimeoutConfig() {
    return {
      navigation: this.get('navigationTimeout'),
      elementWait: this.get('elementWaitTimeout'),
      messageCompose: this.get('messageComposeTimeout'),
      postCreation: this.get('postCreationTimeout'),
      connectionRequest: this.get('connectionRequestTimeout'),
      browserLaunch: this.get('browserLaunchTimeout'),
      pageLoad: this.get('pageLoadTimeout'),
    };
  }

  /**
   * Get error handling configuration
   * @returns {Object} Error handling configuration
   */
  getErrorHandlingConfig() {
    return {
      maxConsecutiveErrors: this.get('maxConsecutiveErrors'),
      errorCooldownDuration: this.get('errorCooldownDuration'),
      retryAttempts: this.get('retryAttempts'),
      retryBaseDelay: this.get('retryBaseDelay'),
      retryMaxDelay: this.get('retryMaxDelay'),
      retryJitterFactor: this.get('retryJitterFactor'),
    };
  }

  /**
   * Get monitoring and logging configuration
   * @returns {Object} Monitoring configuration
   */
  getMonitoringConfig() {
    return {
      performanceLoggingEnabled: this.get('performanceLoggingEnabled'),
      auditLoggingEnabled: this.get('auditLoggingEnabled'),
      metricsCollectionInterval: this.get('metricsCollectionInterval'),
      debugMode: this.get('debugMode'),
      screenshotOnError: this.get('screenshotOnError'),
      savePageSourceOnError: this.get('savePageSourceOnError'),
      verboseLogging: this.get('verboseLogging'),
    };
  }

  /**
   * Check if a specific feature is enabled.
   * Checks local config first (env var escape hatch), then control plane flags.
   * @param {string} feature - Feature name
   * @returns {boolean} Whether feature is enabled
   */
  isFeatureEnabled(feature) {
    // Local config keys always override (env var escape hatch)
    const featureMap = {
      messageSending: 'enableMessageSending',
      connectionRequests: 'enableConnectionRequests',
      postCreation: 'enablePostCreation',
      humanBehavior: 'enableHumanBehavior',
      suspiciousActivityDetection: 'enableSuspiciousActivityDetection',
    };

    const configKey = featureMap[feature];
    if (configKey) {
      const localValue = this.get(configKey);
      if (localValue === false) return false; // local false always overrides
      if (localValue !== undefined && localValue !== null) return Boolean(localValue);
    }

    // Check control plane feature flags from config cache (populated by _loadFeatureFlags)
    const cpValue = ConfigManager.configCache.get(`featureFlags.${feature}`);
    if (cpValue !== undefined) return Boolean(cpValue);

    // Fallback: check ControlPlaneService's module-level cache directly.
    // This covers the race window between startup and async _loadFeatureFlags completing.
    try {
      const cpService = new ControlPlaneService();
      if (cpService.isConfigured) {
        return cpService.isFeatureEnabled(feature);
      }
    } catch {
      // CP service unavailable, fall through to default
    }

    return false;
  }

  /**
   * Get environment-specific configuration adjustments
   * @returns {Object} Environment-specific settings
   */
  getEnvironmentConfig() {
    const isProduction = config.nodeEnv === 'production';
    const isDevelopment = config.nodeEnv === 'development';

    return {
      environment: config.nodeEnv,
      isProduction,
      isDevelopment,
      adjustments: {
        // More conservative settings in production
        maxConcurrentInteractions: isProduction
          ? Math.min(this.get('maxConcurrentInteractions'), 3)
          : this.get('maxConcurrentInteractions'),

        // Longer delays in production for safety
        humanDelayMin: isProduction
          ? Math.max(this.get('humanDelayMin'), 2000)
          : this.get('humanDelayMin'),

        // More retries in production for reliability
        retryAttempts: isProduction
          ? Math.max(this.get('retryAttempts'), 3)
          : this.get('retryAttempts'),

        // Debug features only in development
        debugMode: isDevelopment && this.get('debugMode'),
        screenshotOnError: isDevelopment && this.get('screenshotOnError'),
        verboseLogging: isDevelopment && this.get('verboseLogging'),
      },
    };
  }

  /**
   * Validate current configuration
   * @returns {Object} Validation result
   */
  validateConfiguration() {
    const validation = ConfigValidator.validateConfiguration();
    this.lastValidation = validation;

    // Notify watchers of validation results
    this.notifyConfigWatchers('validation', validation);

    return validation;
  }

  /**
   * Get last validation result
   * @returns {Object} Last validation result
   */
  getLastValidation() {
    return this.lastValidation;
  }

  /**
   * Add configuration watcher
   * @param {Function} callback - Callback function for configuration changes
   */
  addConfigWatcher(callback) {
    ConfigManager.configWatchers.add(callback);
  }

  /**
   * Remove configuration watcher
   * @param {Function} callback - Callback function to remove
   */
  removeConfigWatcher(callback) {
    ConfigManager.configWatchers.delete(callback);
  }

  /**
   * Notify configuration watchers
   * @param {string} event - Event type
   * @param {any} data - Event data
   */
  notifyConfigWatchers(event, data) {
    ConfigManager.configWatchers.forEach((callback) => {
      try {
        callback(event, data);
      } catch (error) {
        logger.error('Error in configuration watcher:', error);
      }
    });
  }

  /**
   * Get configuration health status
   * @returns {Object} Configuration health information
   */
  getHealthStatus() {
    const validation = this.lastValidation || { isValid: false, errors: ['Not validated'] };

    return {
      isValid: validation.isValid,
      lastValidated: validation.timestamp || new Date().toISOString(),
      errorCount: validation.errors?.length || 0,
      warningCount: validation.warnings?.length || 0,
      cacheSize: ConfigManager.configCache.size,
      watcherCount: ConfigManager.configWatchers.size,
      environment: config.nodeEnv,
    };
  }

  /**
   * Clear configuration cache
   */
  clearCache() {
    ConfigManager.configCache.clear();
    this.cacheFrequentlyUsedConfig();
    logger.info('Configuration cache cleared and refreshed');
  }

  /**
   * Get configuration statistics for monitoring
   * @returns {Object} Configuration statistics
   */
  getStatistics() {
    return {
      totalConfigKeys: Object.keys(this.config).length,
      cachedKeys: ConfigManager.configCache.size,
      enabledFeatures: [
        'enableMessageSending',
        'enableConnectionRequests',
        'enablePostCreation',
        'enableHumanBehavior',
        'enableSuspiciousActivityDetection',
      ].filter((key) => this.get(key)).length,
      environment: config.nodeEnv,
      lastValidation: this.lastValidation?.timestamp,
      validationStatus: this.lastValidation?.isValid ? 'valid' : 'invalid',
    };
  }
}

// Export singleton instance
export default ConfigManager.getInstance();
