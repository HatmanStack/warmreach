import { logger } from '#utils/logger.js';

/**
 * LinkedIn Error Handler - Comprehensive error categorization and handling
 * Implements requirement 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
export class LinkedInErrorHandler {
  /**
   * Error categories for classification
   */
  static ERROR_CATEGORIES = {
    AUTHENTICATION: 'AUTHENTICATION',
    BROWSER: 'BROWSER',
    LINKEDIN: 'LINKEDIN',
    VALIDATION: 'VALIDATION',
    RATE_LIMIT: 'RATE_LIMIT',
    NETWORK: 'NETWORK',
    SYSTEM: 'SYSTEM',
  };

  /**
   * Error codes with detailed information
   */
  static ERROR_CODES = {
    // Authentication Errors
    JWT_INVALID: {
      category: 'AUTHENTICATION',
      httpStatus: 401,
      message: 'Invalid or expired JWT token',
      suggestions: ['Refresh your authentication token', 'Log in again'],
    },
    LINKEDIN_AUTH_REQUIRED: {
      category: 'AUTHENTICATION',
      httpStatus: 401,
      message: 'LinkedIn authentication required',
      suggestions: [
        'Check LinkedIn login status',
        'Verify account credentials',
        'Complete LinkedIn login process',
      ],
    },
    LINKEDIN_SESSION_EXPIRED: {
      category: 'AUTHENTICATION',
      httpStatus: 401,
      message: 'LinkedIn session has expired',
      suggestions: ['Re-authenticate with LinkedIn', 'Check if account is locked'],
    },

    // Browser Errors
    BROWSER_CRASH: {
      category: 'BROWSER',
      httpStatus: 503,
      message: 'Browser session crashed',
      suggestions: [
        'Retry the request',
        'Check system resources',
        'Restart the service if problem persists',
      ],
    },
    BROWSER_TIMEOUT: {
      category: 'BROWSER',
      httpStatus: 504,
      message: 'Browser operation timed out',
      suggestions: [
        'Retry with longer timeout',
        'Check network connectivity',
        'Verify LinkedIn is accessible',
      ],
    },
    BROWSER_NAVIGATION_FAILED: {
      category: 'BROWSER',
      httpStatus: 503,
      message: 'Failed to navigate to LinkedIn page',
      suggestions: [
        'Check LinkedIn URL validity',
        'Verify network connectivity',
        'Try again later',
      ],
    },
    ELEMENT_NOT_FOUND: {
      category: 'BROWSER',
      httpStatus: 422,
      message: 'Required page element not found',
      suggestions: [
        'LinkedIn interface may have changed',
        'Try refreshing the page',
        'Contact support if issue persists',
      ],
    },

    // LinkedIn Platform Errors
    LINKEDIN_RATE_LIMIT: {
      category: 'RATE_LIMIT',
      httpStatus: 429,
      message: 'LinkedIn rate limiting detected',
      retryAfter: 300000, // 5 minutes
      suggestions: [
        'Wait 5 minutes before retrying',
        'Reduce interaction frequency',
        'Spread requests over longer time periods',
      ],
    },
    LINKEDIN_SUSPICIOUS_ACTIVITY: {
      category: 'RATE_LIMIT',
      httpStatus: 429,
      message: 'LinkedIn detected suspicious activity',
      retryAfter: 1800000, // 30 minutes
      suggestions: [
        'Wait 30 minutes before retrying',
        'Reduce automation frequency',
        'Use more human-like behavior patterns',
      ],
    },
    PROFILE_NOT_FOUND: {
      category: 'LINKEDIN',
      httpStatus: 404,
      message: 'LinkedIn profile not found',
      suggestions: [
        'Verify the profile ID is correct',
        'Check if profile is public',
        'Profile may have been deleted',
      ],
    },
    ALREADY_CONNECTED: {
      category: 'LINKEDIN',
      httpStatus: 409,
      message: 'Profile is already connected',
      suggestions: ['Check connection status', 'Send a message instead', 'Update your records'],
    },
    MESSAGE_BLOCKED: {
      category: 'LINKEDIN',
      httpStatus: 403,
      message: 'Message sending blocked by LinkedIn',
      suggestions: [
        'Check if recipient accepts messages',
        'Verify account standing',
        'Try connecting first',
      ],
    },
    POST_CREATION_FAILED: {
      category: 'LINKEDIN',
      httpStatus: 422,
      message: 'Post creation failed',
      suggestions: [
        'Check post content for violations',
        'Verify media attachments',
        'Try again with different content',
      ],
    },

    // Validation Errors
    INVALID_PROFILE_ID: {
      category: 'VALIDATION',
      httpStatus: 400,
      message: 'Invalid profile ID format',
      suggestions: ['Provide a valid LinkedIn profile ID', 'Check profile URL format'],
    },
    CONTENT_TOO_LONG: {
      category: 'VALIDATION',
      httpStatus: 400,
      message: 'Content exceeds maximum length',
      suggestions: ['Reduce content length', 'Split into multiple messages/posts'],
    },
    MISSING_REQUIRED_FIELD: {
      category: 'VALIDATION',
      httpStatus: 400,
      message: 'Missing required field',
      suggestions: ['Provide all required fields', 'Check API documentation'],
    },

    // Network Errors
    NETWORK_ERROR: {
      category: 'NETWORK',
      httpStatus: 503,
      message: 'Network connectivity issue',
      suggestions: [
        'Check internet connection',
        'Verify LinkedIn is accessible',
        'Try again later',
      ],
    },
    DNS_RESOLUTION_FAILED: {
      category: 'NETWORK',
      httpStatus: 503,
      message: 'Failed to resolve LinkedIn domain',
      suggestions: [
        'Check DNS settings',
        'Verify network configuration',
        'Try using different DNS server',
      ],
    },

    // System Errors
    MEMORY_LIMIT_EXCEEDED: {
      category: 'SYSTEM',
      httpStatus: 507,
      message: 'System memory limit exceeded',
      suggestions: [
        'Reduce concurrent operations',
        'Restart the service',
        'Check system resources',
      ],
    },
    DISK_SPACE_LOW: {
      category: 'SYSTEM',
      httpStatus: 507,
      message: 'Insufficient disk space',
      suggestions: ['Free up disk space', 'Clean temporary files', 'Contact system administrator'],
    },
  };

  /**
   * Categorize error based on error message and context
   */
  static categorizeError(error) {
    const errorMessage = error.message.toLowerCase();

    // Authentication errors
    if (
      errorMessage.includes('jwt') ||
      errorMessage.includes('token') ||
      errorMessage.includes('unauthorized')
    ) {
      return this.ERROR_CODES.JWT_INVALID;
    }
    if (
      errorMessage.includes('authentication') ||
      errorMessage.includes('login') ||
      errorMessage.includes('auth')
    ) {
      return this.ERROR_CODES.LINKEDIN_AUTH_REQUIRED;
    }
    if (errorMessage.includes('session expired') || errorMessage.includes('logged out')) {
      return this.ERROR_CODES.LINKEDIN_SESSION_EXPIRED;
    }

    // Browser errors
    if (
      errorMessage.includes('browser') &&
      (errorMessage.includes('crash') || errorMessage.includes('closed'))
    ) {
      return this.ERROR_CODES.BROWSER_CRASH;
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      return this.ERROR_CODES.BROWSER_TIMEOUT;
    }
    if (errorMessage.includes('navigation') || errorMessage.includes('navigate')) {
      return this.ERROR_CODES.BROWSER_NAVIGATION_FAILED;
    }
    if (errorMessage.includes('element not found') || errorMessage.includes('selector')) {
      return this.ERROR_CODES.ELEMENT_NOT_FOUND;
    }

    // Rate limiting and LinkedIn platform errors
    if (errorMessage.includes('rate limit') || errorMessage.includes('too many requests')) {
      return this.ERROR_CODES.LINKEDIN_RATE_LIMIT;
    }
    if (
      errorMessage.includes('suspicious') ||
      errorMessage.includes('blocked') ||
      errorMessage.includes('restricted')
    ) {
      return this.ERROR_CODES.LINKEDIN_SUSPICIOUS_ACTIVITY;
    }
    if (errorMessage.includes('profile not found') || errorMessage.includes('user not found')) {
      return this.ERROR_CODES.PROFILE_NOT_FOUND;
    }
    if (errorMessage.includes('already connected') || errorMessage.includes('connection exists')) {
      return this.ERROR_CODES.ALREADY_CONNECTED;
    }
    if (
      errorMessage.includes('message blocked') ||
      errorMessage.includes('messaging not allowed')
    ) {
      return this.ERROR_CODES.MESSAGE_BLOCKED;
    }
    if (
      errorMessage.includes('post') &&
      (errorMessage.includes('failed') || errorMessage.includes('error'))
    ) {
      return this.ERROR_CODES.POST_CREATION_FAILED;
    }

    // Network errors
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('enotfound')
    ) {
      return this.ERROR_CODES.NETWORK_ERROR;
    }
    if (errorMessage.includes('dns') || errorMessage.includes('resolve')) {
      return this.ERROR_CODES.DNS_RESOLUTION_FAILED;
    }

    // System errors
    if (errorMessage.includes('memory') || errorMessage.includes('heap')) {
      return this.ERROR_CODES.MEMORY_LIMIT_EXCEEDED;
    }
    if (errorMessage.includes('disk') || errorMessage.includes('space')) {
      return this.ERROR_CODES.DISK_SPACE_LOW;
    }

    // Default to generic system error
    return {
      category: 'SYSTEM',
      httpStatus: 500,
      message: 'Internal system error',
      suggestions: ['Try again later', 'Contact support if problem persists'],
    };
  }

  /**
   * Create structured error response with actionable suggestions
   */
  static createErrorResponse(error, context = {}, requestId = null) {
    const categorizedError = this.categorizeError(error, context);
    const timestamp = new Date().toISOString();

    // Log the error with full context
    this.logError(error, categorizedError, context, requestId);

    // Create structured response
    const errorResponse = {
      success: false,
      error: {
        code: this.getErrorCode(categorizedError, error),
        category: categorizedError.category,
        message: categorizedError.message,
        details: this.getErrorDetails(error, context),
        suggestions: categorizedError.suggestions || [],
        timestamp,
        requestId,
      },
    };

    // Add retry information for rate limiting errors
    if (categorizedError.retryAfter) {
      errorResponse.error.retryAfter = categorizedError.retryAfter;
      errorResponse.error.retryAt = new Date(
        Date.now() + categorizedError.retryAfter
      ).toISOString();
    }

    return {
      response: errorResponse,
      httpStatus: categorizedError.httpStatus,
    };
  }

  /**
   * Generate error code based on categorized error and original error
   */
  static getErrorCode(categorizedError) {
    // Find matching error code
    for (const [code, errorInfo] of Object.entries(this.ERROR_CODES)) {
      if (errorInfo === categorizedError) {
        return code;
      }
    }

    // Generate generic code based on category
    return `${categorizedError.category}_ERROR`;
  }

  /**
   * Get detailed error information for debugging
   */
  static getErrorDetails(error, context) {
    if (process.env.NODE_ENV === 'development') {
      return error.message;
    }

    // In production, provide sanitized details
    if (context.operation) {
      return `Error occurred during ${context.operation}`;
    }

    return 'An error occurred while processing your request';
  }

  /**
   * Log error with comprehensive information for audit trails
   */
  static logError(error, categorizedError, context, requestId) {
    const logData = {
      requestId,
      errorCategory: categorizedError.category,
      errorCode: this.getErrorCode(categorizedError, error),
      errorMessage: error.message,
      errorStack: error.stack,
      context,
      timestamp: new Date().toISOString(),
      httpStatus: categorizedError.httpStatus,
    };

    // Log at appropriate level based on error category
    switch (categorizedError.category) {
      case 'AUTHENTICATION':
        logger.warn('Authentication error occurred', logData);
        break;
      case 'VALIDATION':
        logger.info('Validation error occurred', logData);
        break;
      case 'RATE_LIMIT':
        logger.warn('Rate limiting detected', logData);
        break;
      case 'BROWSER':
      case 'LINKEDIN':
      case 'NETWORK':
      case 'SYSTEM':
        logger.error('System error occurred', logData);
        break;
      default:
        logger.error('Unknown error occurred', logData);
    }
  }

  /**
   * Implement backoff strategy for rate limiting
   */
  static calculateBackoffDelay(attemptCount, errorCategory) {
    const baseDelay = 1000; // 1 second
    const maxDelay = 300000; // 5 minutes

    let delay;
    switch (errorCategory) {
      case 'RATE_LIMIT':
        // Exponential backoff for rate limiting
        delay = Math.min(baseDelay * Math.pow(2, attemptCount), maxDelay);
        break;
      case 'BROWSER':
        // Linear backoff for browser errors
        delay = Math.min(baseDelay * attemptCount, 30000); // Max 30 seconds
        break;
      case 'NETWORK':
        // Exponential backoff for network errors
        delay = Math.min(baseDelay * Math.pow(1.5, attemptCount), 60000); // Max 1 minute
        break;
      default:
        // Default linear backoff
        delay = Math.min(baseDelay * attemptCount, 10000); // Max 10 seconds
    }

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * delay;
    return Math.floor(delay + jitter);
  }

  /**
   * Check if error is recoverable and should be retried
   */
  static isRecoverable(categorizedError, attemptCount = 1) {
    const maxAttempts = 3;

    if (attemptCount >= maxAttempts) {
      return false;
    }

    // Recoverable error categories
    const recoverableCategories = ['BROWSER', 'NETWORK', 'SYSTEM'];

    // Rate limiting is recoverable but with longer delays
    if (categorizedError.category === 'RATE_LIMIT') {
      return attemptCount <= 2; // Max 2 retries for rate limiting
    }

    return recoverableCategories.includes(categorizedError.category);
  }

  /**
   * Create recovery mechanism for browser crashes
   */
  static createRecoveryPlan(error, context) {
    const categorizedError = this.categorizeError(error, context);

    const recoveryPlan = {
      shouldRecover: this.isRecoverable(categorizedError, context.attemptCount || 1),
      delay: this.calculateBackoffDelay(context.attemptCount || 1, categorizedError.category),
      actions: [],
    };

    switch (categorizedError.category) {
      case 'BROWSER':
        recoveryPlan.actions = [
          'Cleanup existing browser session',
          'Initialize new browser instance',
          'Re-authenticate with LinkedIn if needed',
          'Retry original operation',
        ];
        break;
      case 'RATE_LIMIT':
        recoveryPlan.actions = [
          'Wait for rate limit window to reset',
          'Implement human-like delays',
          'Reduce operation frequency',
          'Retry with backoff strategy',
        ];
        break;
      case 'AUTHENTICATION':
        recoveryPlan.actions = [
          'Clear existing authentication state',
          'Prompt for re-authentication',
          'Validate new credentials',
          'Retry original operation',
        ];
        break;
      case 'NETWORK':
        recoveryPlan.actions = [
          'Check network connectivity',
          'Verify LinkedIn accessibility',
          'Retry with exponential backoff',
          'Switch to backup network if available',
        ];
        break;
      default:
        recoveryPlan.actions = [
          'Log error for investigation',
          'Retry with basic backoff',
          'Escalate if problem persists',
        ];
    }

    return recoveryPlan;
  }
}

export default LinkedInErrorHandler;
