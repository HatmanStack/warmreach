import { logger } from '#utils/logger.js';
import {
  initializeLinkedInServices,
  cleanupLinkedInServices,
} from '../../../shared/utils/serviceFactory.js';
import { validateLinkedInCredentials } from '../../../shared/utils/credentialValidator.js';
import ProfileInitService from '../services/profileInitService.js';
import { HealingManager } from '../../automation/utils/healingManager.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { profileInitMonitor } from '../utils/profileInitMonitor.js';

export class ProfileInitController {
  async performProfileInit(req, res, opts = {}) {
    const requestId = this._generateRequestId();
    const startTime = Date.now();

    // Enhanced request logging with request ID for tracking
    this._logRequestDetails(req, requestId);

    try {
      const jwtToken = this._extractJwtToken(req);
      if (!jwtToken) {
        logger.warn('Profile initialization request rejected: Missing JWT token', { requestId });
        return res.status(401).json({
          error: 'Missing or invalid Authorization header',
          requestId,
        });
      }

      const validationResult = this._validateRequest(req.body, jwtToken);
      if (!validationResult.isValid) {
        logger.warn('Profile initialization request validation failed', {
          requestId,
          error: validationResult.error,
          statusCode: validationResult.statusCode,
        });
        return res.status(validationResult.statusCode).json({
          error: validationResult.error,
          message: validationResult.message,
          requestId,
        });
      }

      // Do not decrypt here; pass ciphertext through and decrypt at login
      const searchName = null;
      const searchPassword = null;
      const credentialsCiphertext = req.body.linkedinCredentialsCiphertext;

      logger.info('Starting LinkedIn profile initialization request', {
        requestId,
        username: searchName ? '[REDACTED]' : 'not provided',
        hasPassword: !!searchPassword,
        recursionCount: opts.recursionCount || 0,
        healPhase: opts.healPhase || null,
      });

      const state = ProfileInitStateManager.buildInitialState({
        searchName,
        searchPassword,
        credentialsCiphertext,
        jwtToken,
        requestId,
        ...opts,
      });

      // Start monitoring this request
      profileInitMonitor.startRequest(requestId, {
        username: searchName ? '[REDACTED]' : 'not provided',
        recursionCount: opts.recursionCount || 0,
        healPhase: opts.healPhase,
        isResuming: ProfileInitStateManager.isResumingState(state),
      });

      const result = await this.performProfileInitFromState(state);

      if (result === undefined) {
        const healingDuration = Date.now() - startTime;
        logger.info('Profile initialization triggered healing process', {
          requestId,
          healingDuration,
          recursionCount: state.recursionCount,
        });

        // Record healing in monitoring
        profileInitMonitor.recordHealing(requestId, {
          recursionCount: state.recursionCount,
          healPhase: state.healPhase,
          healReason: state.healReason,
        });

        return res.status(202).json({
          status: 'healing',
          message: 'Worker process started for healing/recovery.',
          requestId,
          healingInfo: {
            phase: state.healPhase,
            reason: state.healReason,
            recursionCount: state.recursionCount,
          },
        });
      }

      const totalDuration = Date.now() - startTime;
      logger.info('Profile initialization completed successfully', {
        requestId,
        totalDuration,
        processedConnections: result.data?.processed || 0,
        skippedConnections: result.data?.skipped || 0,
        errorCount: result.data?.errors || 0,
      });

      // Record success in monitoring
      profileInitMonitor.recordSuccess(requestId, result);

      res.json(this._buildSuccessResponse(result, requestId));
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      const errorDetails = this._categorizeError(error);

      logger.error('Profile initialization failed with unhandled error', {
        requestId,
        totalDuration,
        errorType: errorDetails.type,
        errorCategory: errorDetails.category,
        message: error.message,
        stack: error.stack,
        isRecoverable: errorDetails.isRecoverable,
      });

      // Log additional context for debugging
      if (error.context) {
        logger.error('Error context details', {
          requestId,
          context: error.context,
        });
      }

      // Record failure in monitoring
      profileInitMonitor.recordFailure(requestId, error, errorDetails);

      res.status(500).json(this._buildErrorResponse(error, requestId, errorDetails));
    }
  }

  async performProfileInitFromState(state) {
    const services = await this._initializeServices();

    try {
      // Note: Authentication is now handled within ProfileInitService
      // to maintain consistency with the service's state management
      const profileData = await this._processUserProfile(services, state);

      return this._buildProfileInitResult(profileData);
    } catch (error) {
      logger.error('Profile initialization failed:', error);
      throw error;
    } finally {
      await this._cleanupServices(services);
    }
  }

  async _initializeServices() {
    return await initializeLinkedInServices();
  }

  async _processUserProfile(services, state) {
    logger.info('Processing user profile initialization...');

    try {
      // Initialize ProfileInitService with all required services
      const profileInitService = new ProfileInitService(
        services.puppeteerService,
        services.linkedInService,
        services.linkedInContactService,
        services.dynamoDBService
      );

      // Set auth token for DynamoDB operations
      services.dynamoDBService.setAuthToken(state.jwtToken);

      // Process the profile initialization using the service
      const result = await profileInitService.initializeUserProfile(state);

      logger.info('Profile initialization processing completed successfully');
      return result;
    } catch (error) {
      logger.error('Profile initialization processing failed:', error);

      // Check if this is a recoverable error that should trigger healing
      if (this._shouldTriggerHealing(error)) {
        await this._handleProfileInitHealing(state);
        return undefined; // Signal healing in progress
      }

      throw error;
    }
  }

  async _handleProfileInitHealing(state, errorMessage = 'Profile initialization failed') {
    const requestId = state.requestId || 'unknown';
    const recursionCount = (state.recursionCount || 0) + 1;

    // Check if this is a list creation healing scenario
    if (errorMessage.includes('LIST_CREATION_HEALING_NEEDED')) {
      try {
        const healingDataMatch = errorMessage.match(/LIST_CREATION_HEALING_NEEDED:(.+)$/);
        if (healingDataMatch) {
          const healingState = JSON.parse(healingDataMatch[1]);

          logger.warn('List creation failed. Initiating list creation healing restart.', {
            requestId,
            connectionType: healingState.listCreationState?.connectionType,
            expansionAttempt: healingState.listCreationState?.expansionAttempt,
            currentFileIndex: healingState.listCreationState?.currentFileIndex,
            recursionCount: healingState.recursionCount,
          });

          await this._initiateHealing(healingState);
          return;
        }
      } catch (parseError) {
        logger.warn(
          'Failed to parse list creation healing data, falling back to standard healing',
          {
            requestId,
            parseError: parseError.message,
          }
        );
      }
    }

    logger.warn('Profile initialization failed. Initiating self-healing restart.', {
      requestId,
      recursionCount,
      errorMessage,
      currentState: {
        processingList: state.currentProcessingList,
        batch: state.currentBatch,
        index: state.currentIndex,
        masterIndexFile: state.masterIndexFile,
      },
    });

    logger.info('Restarting with fresh Puppeteer instance...', {
      requestId,
      recursionCount,
    });

    // Create healing state using ProfileInitStateManager
    const healingState = ProfileInitStateManager.createHealingState(
      state,
      'profile-init',
      errorMessage,
      {
        recursionCount,
        timestamp: new Date().toISOString(),
      }
    );

    // Log healing state for debugging
    logger.info('Created healing state for profile initialization', {
      requestId,
      healingState: {
        recursionCount: healingState.recursionCount,
        healPhase: healingState.healPhase,
        healReason: healingState.healReason,
        currentProcessingList: healingState.currentProcessingList,
        currentBatch: healingState.currentBatch,
        currentIndex: healingState.currentIndex,
        masterIndexFile: healingState.masterIndexFile,
      },
    });

    await this._initiateHealing(healingState);
  }

  /**
   * Determine if an error should trigger healing/recovery
   * @param {Error} error - The error that occurred
   * @returns {boolean} True if healing should be triggered
   */
  _shouldTriggerHealing(error) {
    // Define recoverable error patterns following SearchController patterns
    const recoverableErrors = [
      /login.*failed/i,
      /authentication.*failed/i,
      /network.*error/i,
      /timeout/i,
      /connection.*reset/i,
      /captcha/i,
      /checkpoint/i,
      /rate.*limit/i,
      /linkedin.*error/i,
      /puppeteer.*error/i,
      /navigation.*failed/i,
      /LIST_CREATION_HEALING_NEEDED/i,
    ];

    const errorMessage = error.message || error.toString();

    // Check for list creation healing specifically
    if (errorMessage.includes('LIST_CREATION_HEALING_NEEDED')) {
      logger.info(`List creation healing needed: ${errorMessage}`);
      return true;
    }

    // Check if error matches any recoverable pattern
    const isRecoverable = recoverableErrors.some((pattern) => pattern.test(errorMessage));

    if (isRecoverable) {
      logger.info(`Error is recoverable, will trigger healing: ${errorMessage}`);
      return true;
    }

    logger.info(`Error is not recoverable, will not trigger healing: ${errorMessage}`);
    return false;
  }

  async _initiateHealing(healingParams) {
    const healingManager = new HealingManager();
    await healingManager.healAndRestart(healingParams);
  }

  async _cleanupServices(services) {
    logger.info('Cleaning up services for profile initialization:', !!services?.puppeteerService);
    await cleanupLinkedInServices(services);
    logger.info('Closed browser for profile initialization!');
  }

  _validateRequest(body, jwtToken) {
    const { searchName, searchPassword, linkedinCredentialsCiphertext, linkedinCredentials } = body;

    logger.info('Profile init request body received:', {
      searchName,
      hasPassword: !!searchPassword,
      hasJwtToken: !!jwtToken,
    });

    return validateLinkedInCredentials({
      searchName,
      searchPassword,
      linkedinCredentialsCiphertext,
      linkedinCredentials,
      jwtToken,
      actionType: 'profile initialization',
    });
  }

  _logRequestDetails(req, requestId) {
    logger.info('Profile init request details:', {
      requestId,
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
      contentType: req.headers['content-type'],
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Generate unique request ID for tracking
   * @returns {string} Unique request identifier
   */
  _generateRequestId() {
    return `profile-init-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Categorize errors for better handling and logging
   * @param {Error} error - The error to categorize
   * @returns {Object} Error categorization details
   */
  _categorizeError(error) {
    const errorMessage = error.message || error.toString();

    // Authentication errors
    if (
      /login.*failed|authentication.*failed|invalid.*credentials|unauthorized/i.test(errorMessage)
    ) {
      return {
        type: 'AuthenticationError',
        category: 'authentication',
        isRecoverable: true,
        severity: 'high',
        userMessage: 'LinkedIn authentication failed. Please check your credentials.',
      };
    }

    // Network errors
    if (
      /network.*error|connection.*reset|timeout|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(errorMessage)
    ) {
      return {
        type: 'NetworkError',
        category: 'network',
        isRecoverable: true,
        severity: 'medium',
        userMessage: 'Network connection issue. The system will retry automatically.',
      };
    }

    // LinkedIn-specific errors
    if (/captcha|checkpoint|rate.*limit|linkedin.*error|too.*many.*requests/i.test(errorMessage)) {
      return {
        type: 'LinkedInError',
        category: 'linkedin',
        isRecoverable: true,
        severity: 'high',
        userMessage: 'LinkedIn has imposed restrictions. The system will retry with delays.',
      };
    }

    // Database errors
    if (
      /dynamodb|database|aws.*error|ValidationException|ResourceNotFoundException/i.test(
        errorMessage
      )
    ) {
      return {
        type: 'DatabaseError',
        category: 'database',
        isRecoverable: false,
        severity: 'high',
        userMessage: 'Database operation failed. Please try again later.',
      };
    }

    // Puppeteer/Browser errors
    if (/puppeteer|browser|page.*crashed|navigation.*failed|target.*closed/i.test(errorMessage)) {
      return {
        type: 'BrowserError',
        category: 'browser',
        isRecoverable: true,
        severity: 'medium',
        userMessage: 'Browser automation issue. The system will restart and retry.',
      };
    }

    // Validation errors
    if (/validation|invalid.*input|missing.*required|bad.*request/i.test(errorMessage)) {
      return {
        type: 'ValidationError',
        category: 'validation',
        isRecoverable: false,
        severity: 'low',
        userMessage: 'Invalid input provided. Please check your request data.',
      };
    }

    // File system errors
    if (/ENOENT|EACCES|EMFILE|file.*not.*found|permission.*denied/i.test(errorMessage)) {
      return {
        type: 'FileSystemError',
        category: 'filesystem',
        isRecoverable: false,
        severity: 'medium',
        userMessage: 'File system error occurred. Please contact support.',
      };
    }

    // Default categorization for unknown errors
    return {
      type: 'UnknownError',
      category: 'unknown',
      isRecoverable: false,
      severity: 'high',
      userMessage: 'An unexpected error occurred. Please try again later.',
    };
  }

  _extractJwtToken(req) {
    const authHeader = req.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
  }

  _buildSuccessResponse(result, requestId) {
    return {
      status: 'success',
      data: result,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  _buildErrorResponse(error, requestId, errorDetails) {
    const response = {
      error: 'Internal server error during profile initialization',
      message: errorDetails?.userMessage || error.message,
      requestId,
      errorType: errorDetails?.type || 'UnknownError',
      timestamp: new Date().toISOString(),
    };

    // Include technical details in development mode
    if (process.env.NODE_ENV === 'development') {
      response.technicalDetails = {
        originalMessage: error.message,
        stack: error.stack,
        category: errorDetails?.category,
        severity: errorDetails?.severity,
        isRecoverable: errorDetails?.isRecoverable,
      };
    }

    return response;
  }

  _buildProfileInitResult(profileData) {
    return {
      profileData,
      stats: {
        initializationTime: new Date().toISOString(),
      },
    };
  }

  /**
   * Transport-agnostic: initialize profile via WebSocket command.
   * @param {object} payload - { jwtToken, linkedInEmail, linkedInPassword, ... }
   * @param {function} onProgress - progress callback
   */
  async initializeDirect(payload, onProgress) {
    const fakeReq = {
      body: payload,
      jwtToken: payload.jwtToken,
      headers: { authorization: `Bearer ${payload.jwtToken || ''}` },
      path: '/profile-init',
      method: 'POST',
    };
    let resultData = null;
    const fakeRes = {
      status: (code) => ({
        json: (data) => {
          resultData = { statusCode: code, ...data };
        },
      }),
      json: (data) => {
        resultData = { statusCode: 200, ...data };
      },
    };

    await this.performProfileInit(fakeReq, fakeRes, { progressCallback: onProgress });
    if (resultData?.error) {
      const err = new Error(resultData.error);
      err.code = 'PROFILE_INIT_ERROR';
      throw err;
    }
    return resultData;
  }
}

export default ProfileInitController;
