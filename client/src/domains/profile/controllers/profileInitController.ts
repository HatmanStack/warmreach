import type { Request, Response } from 'express';
import { logger } from '#utils/logger.js';
import {
  initializeLinkedInServices,
  cleanupLinkedInServices,
  type LinkedInServices,
} from '../../../shared/utils/serviceFactory.js';
import {
  validateLinkedInCredentials,
  type CredentialValidationResult,
} from '../../../shared/utils/credentialValidator.js';
import {
  ProfileInitService,
  type InitializationResult,
  type ProfileInitState,
} from '../services/profileInitService.js';
import { LocalProfileScraper } from '../../linkedin/services/localProfileScraper.js';
import { MutualConnectionsCollector } from '../../linkedin/services/mutualConnectionsCollector.js';
import { BurstThrottleManager } from '../../automation/utils/burstThrottleManager.js';
import { HealingRequiredError } from '../../automation/utils/healingError.js';
import { config } from '#shared-config/index.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { profileInitMonitor } from '../utils/profileInitMonitor.js';

/**
 * Categorized error metadata produced by {@link ProfileInitController._categorizeError}.
 */
interface ProfileInitErrorDetails {
  type: string;
  category: string;
  isRecoverable: boolean;
  severity: string;
  userMessage: string;
}

/**
 * Wrapped result returned by the profile-init pipeline on success. The pipeline
 * nests the service's {@link InitializationResult} under `profileData` alongside
 * timing stats.
 */
interface ProfileInitResult {
  profileData: InitializationResult;
  stats: { initializationTime: string };
}

// Cap on in-process healing resumes before a run is aborted with a real error.
const MAX_HEALING_ATTEMPTS = 3;

export class ProfileInitController {
  async performProfileInit(
    req: Request,
    res: Response,
    opts: Record<string, unknown> = {}
  ): Promise<void> {
    const requestId = this._generateRequestId();
    const startTime = Date.now();

    // In-process self-healing (P0-1) can resume through up to
    // MAX_HEALING_ATTEMPTS full login+scrape cycles, producing no bytes on the
    // response socket for minutes. Disable this handler's idle timeouts so a
    // long heal isn't dropped mid-run by the default socket timeout; the healing
    // loop's own cap bounds total duration. Guarded for non-HTTP callers/tests.
    req.setTimeout?.(0);
    res.setTimeout?.(0);

    // Enhanced request logging with request ID for tracking
    this._logRequestDetails(req, requestId);

    try {
      const jwtToken = this._extractJwtToken(req);
      if (!jwtToken) {
        logger.warn('Profile initialization request rejected: Missing JWT token', { requestId });
        res.status(401).json({
          error: 'Missing or invalid Authorization header',
          requestId,
        });
        return;
      }

      const validationResult = this._validateRequest(req.body, jwtToken);
      if (!validationResult.isValid) {
        logger.warn('Profile initialization request validation failed', {
          requestId,
          error: validationResult.error,
          statusCode: validationResult.statusCode,
        });
        res.status(validationResult.statusCode).json({
          error: validationResult.error,
          message: validationResult.message,
          requestId,
        });
        return;
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

      const result = await this.runProfileInitWithHealing(state);
      // In-process healing never returns undefined on success (it throws on an
      // unrecoverable failure); narrow here so the typed downstream is sound.
      if (result === undefined) {
        throw new Error('Profile initialization returned no result');
      }

      const totalDuration = Date.now() - startTime;
      // The service's processing counts live on the nested InitializationResult
      // (`profileData.data`); typing the pipeline return makes that path
      // explicit instead of reading an always-undefined `result.data`.
      const processingStats = result.profileData?.data;
      logger.info('Profile initialization completed successfully', {
        requestId,
        totalDuration,
        processedConnections: processingStats?.processed || 0,
        skippedConnections: processingStats?.skipped || 0,
        errorCount: processingStats?.errors || 0,
      });

      // Record success in monitoring
      profileInitMonitor.recordSuccess(requestId, result);

      res.json(this._buildSuccessResponse(result, requestId));
    } catch (error: unknown) {
      const totalDuration = Date.now() - startTime;
      const errorDetails = this._categorizeError(error);

      logger.error('Profile initialization failed with unhandled error', {
        requestId,
        totalDuration,
        errorType: errorDetails.type,
        errorCategory: errorDetails.category,
        message: (error as Error).message,
        stack: (error as Error).stack,
        isRecoverable: errorDetails.isRecoverable,
      });

      // Log additional context for debugging
      const errWithContext = error as { context?: unknown };
      if (errWithContext && typeof errWithContext === 'object' && 'context' in errWithContext) {
        logger.error('Error context details', {
          requestId,
          context: errWithContext.context,
        });
      }

      // Record failure in monitoring
      profileInitMonitor.recordFailure(requestId, error as Error, errorDetails);

      res.status(500).json(this._buildErrorResponse(error as Error, requestId, errorDetails));
    }
  }

  /**
   * Runs profile-init and transparently resumes in-process when a recoverable
   * error requests healing. Each attempt re-invokes performProfileInitFromState
   * from the resume state with a fresh browser; capped at MAX_HEALING_ATTEMPTS
   * so a persistently-failing run ends with a real error instead of the old
   * silent worker-spawn no-op.
   */
  async runProfileInitWithHealing(state: ProfileInitState): Promise<ProfileInitResult | undefined> {
    let current = state;
    for (;;) {
      try {
        return await this.performProfileInitFromState(current);
      } catch (error: unknown) {
        if (!(error instanceof HealingRequiredError)) throw error;
        const next = error.healState as ProfileInitState;
        const attempt = next.recursionCount || 0;
        if (attempt > MAX_HEALING_ATTEMPTS) {
          logger.error('Profile-init healing recursion cap reached — aborting run', {
            recursionCount: attempt,
            healPhase: next.healPhase,
            healReason: next.healReason,
          });
          throw new Error(
            `Profile init healing exceeded ${MAX_HEALING_ATTEMPTS} attempts (last reason: ${next.healReason || 'unknown'})`
          );
        }
        logger.warn('Profile-init healing — resuming in-process', {
          recursionCount: attempt,
          healPhase: next.healPhase,
          healReason: next.healReason,
        });
        // Record the healing attempt so the monitor's counters/dashboards reflect
        // in-process recoveries (the worker-spawn path that used to call this was
        // removed with P0-1; without this a run that heals reports zero events).
        profileInitMonitor.recordHealing(next.requestId || current.requestId || 'unknown', {
          recursionCount: attempt,
          healPhase: next.healPhase,
          healReason: next.healReason,
        });
        current = next;
      }
    }
  }

  async performProfileInitFromState(
    state: ProfileInitState
  ): Promise<ProfileInitResult | undefined> {
    const services = await this._initializeServices();

    try {
      // Note: Authentication is now handled within ProfileInitService
      // to maintain consistency with the service's state management
      const profileData = await this._processUserProfile(services, state);

      if (profileData === undefined) {
        return undefined;
      }

      return this._buildProfileInitResult(profileData);
    } catch (error: unknown) {
      // A healing request is a resume signal, not a failure.
      if (error instanceof HealingRequiredError) throw error;
      logger.error('Profile initialization failed:', error);
      throw error;
    } finally {
      await this._cleanupServices(services);
    }
  }

  async _initializeServices(): Promise<LinkedInServices> {
    return await initializeLinkedInServices();
  }

  async _processUserProfile(
    services: LinkedInServices,
    state: ProfileInitState
  ): Promise<InitializationResult | undefined> {
    logger.info('Processing user profile initialization...');

    try {
      // Wire the local profile scraper. Without it, ProfileInitService's
      // localProfileScraper stays null and every connection is stored as a
      // status edge with no scraped name/headline (the "list shows but no
      // names" symptom). The scraper drives the persistent browser page, which
      // is created in puppeteerService.initialize() and reused for login,
      // connection listing, and per-profile scraping.
      const page = services.puppeteerService.getPage();
      const localProfileScraper = page ? new LocalProfileScraper(page) : undefined;
      if (!localProfileScraper) {
        logger.warn(
          'No active browser page at profile-init; scraping disabled and names will be empty'
        );
      }

      // Pace bulk profile-init imports through the burst/break throttle when the
      // native stealth stack is enabled. The manager was previously only ever
      // constructed in its own test, so hundreds of profile scrapes ran back-to-
      // back with no human-like bursts or cooldowns — exactly the rapid-fire
      // pattern LinkedIn rate-limits on. ProfileInitService consumes it in
      // profileBatchProcessing (waitForNext() before each scraped profile).
      const burstThrottleManager = config.puppeteer.enableStealth
        ? new BurstThrottleManager()
        : undefined;

      // Consented mutual-connections collector (B-1 / ADR-6/7/8). Built only
      // when the user opted in (payload.collectMutuals -> state.collectMutuals)
      // AND a live browser page exists; it drives the same persistent page as
      // the scraper. Left undefined otherwise, so collectMutualConnections()
      // stays a strict no-op. NOTE: the `connectionOf` URL form is not yet
      // verified against a live LinkedIn session (see the collector's feasibility
      // gate); until that check confirms the identifier form, collection degrades
      // to [] even when enabled — activation is gated behind the opt-in, which is
      // off by default.
      const mutualConnectionsCollector =
        state.collectMutuals && page ? new MutualConnectionsCollector(page) : undefined;

      // Initialize ProfileInitService with all required services
      const profileInitService = new ProfileInitService(
        services.puppeteerService,
        services.linkedInService,
        services.linkedInContactService,
        services.dynamoDBService,
        localProfileScraper,
        burstThrottleManager,
        undefined, // interactionQueue — not wired in this path
        undefined, // backoffController — not wired in this path
        mutualConnectionsCollector
      );
      logger.info('ProfileInitService constructed', {
        hasLocalProfileScraper: !!localProfileScraper,
        hasBurstThrottle: !!burstThrottleManager,
        hasMutualCollector: !!mutualConnectionsCollector,
      });

      // Set auth token for DynamoDB operations. jwtToken is validated upstream
      // before a state reaches here; the guard satisfies the type and is a
      // no-op at runtime for valid requests.
      if (state.jwtToken) {
        services.dynamoDBService.setAuthToken(state.jwtToken);
      }

      // Process the profile initialization using the service
      const result = await profileInitService.initializeUserProfile(state);

      logger.info('Profile initialization processing completed successfully');
      return result;
    } catch (error: unknown) {
      logger.error('Profile initialization processing failed:', error);

      // Check if this is a recoverable error that should trigger healing.
      // _handleProfileInitHealing throws HealingRequiredError → the
      // runProfileInitWithHealing loop resumes in-process from the heal state.
      if (this._shouldTriggerHealing(error)) {
        await this._handleProfileInitHealing(state);
      }

      throw error;
    }
  }

  async _handleProfileInitHealing(
    state: ProfileInitState,
    errorMessage = 'Profile initialization failed'
  ) {
    const requestId = state.requestId || 'unknown';
    const recursionCount = (state.recursionCount || 0) + 1;

    // Check if this is a list creation healing scenario
    if (errorMessage.includes('LIST_CREATION_HEALING_NEEDED')) {
      try {
        const healingDataMatch = errorMessage.match(/LIST_CREATION_HEALING_NEEDED:(.+)$/);
        if (healingDataMatch) {
          const healingState = JSON.parse(healingDataMatch[1]!);

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
      } catch (parseError: unknown) {
        logger.warn(
          'Failed to parse list creation healing data, falling back to standard healing',
          {
            requestId,
            parseError: (parseError as Error).message,
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
  _shouldTriggerHealing(error: unknown): boolean {
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

    const errorMessage = error instanceof Error ? error.message : String(error);

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

  async _initiateHealing(healingParams: Record<string, unknown>): Promise<never> {
    // In-process healing: unwind the current attempt (its `finally` closes the
    // browser) so runProfileInitWithHealing can resume from this state.
    throw new HealingRequiredError(healingParams);
  }

  async _cleanupServices(services: Partial<LinkedInServices> | null): Promise<void> {
    logger.info('Cleaning up services for profile initialization:', !!services?.puppeteerService);
    await cleanupLinkedInServices(services);
    logger.info('Closed browser for profile initialization!');
  }

  _validateRequest(body: Record<string, unknown>, jwtToken: string): CredentialValidationResult {
    const { searchName, searchPassword, linkedinCredentialsCiphertext, linkedinCredentials } =
      body as {
        searchName?: string;
        searchPassword?: string;
        linkedinCredentialsCiphertext?: string;
        linkedinCredentials?: { email?: string; password?: string };
      };

    logger.info('Profile init request body received:', {
      // Redact the LinkedIn email — it lands in on-disk log rotations,
      // and the agent now injects it into every linkedin:* command.
      searchName: searchName ? '[REDACTED]' : 'not provided',
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

  _logRequestDetails(req: Request, requestId: string): void {
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
    return `profile-init-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Categorize errors for better handling and logging
   * @param {Error} error - The error to categorize
   * @returns {Object} Error categorization details
   */
  _categorizeError(error: unknown): ProfileInitErrorDetails {
    const errorMessage = error instanceof Error ? error.message : String(error);

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

  _extractJwtToken(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  }

  _buildSuccessResponse(result: ProfileInitResult, requestId: string): Record<string, unknown> {
    return {
      status: 'success',
      data: result,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  _buildErrorResponse(
    error: Error,
    requestId: string,
    errorDetails: ProfileInitErrorDetails
  ): Record<string, unknown> {
    const response: Record<string, unknown> = {
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

  _buildProfileInitResult(profileData: InitializationResult): ProfileInitResult {
    return {
      profileData,
      stats: {
        initializationTime: new Date().toISOString(),
      },
    };
  }

  /**
   * Transport-agnostic: initialize profile via WebSocket command.
   * Calls the service layer directly instead of simulating an HTTP request.
   * @param {object} payload - { jwtToken, linkedinCredentialsCiphertext, ... }
   * @param {function} onProgress - progress callback
   */
  async initializeDirect(
    payload: Record<string, unknown>,
    onProgress: (...args: unknown[]) => void
  ) {
    const requestId = this._generateRequestId();
    const jwtToken = typeof payload.jwtToken === 'string' ? payload.jwtToken : undefined;

    if (!jwtToken) {
      const err: Error & { code?: string } = new Error('Missing or invalid Authorization header');
      err.code = 'PROFILE_INIT_ERROR';
      throw err;
    }

    const validationResult = this._validateRequest(payload, jwtToken);
    if (!validationResult.isValid) {
      const err: Error & { code?: string } = new Error(
        validationResult.error || validationResult.message
      );
      err.code = 'PROFILE_INIT_ERROR';
      throw err;
    }

    // Direct/WebSocket path historically only accepted encrypted creds
    // (linkedinCredentialsCiphertext from the frontend's session store).
    // The agent now injects plaintext searchName/searchPassword from its
    // local CredentialStore at the commandRouter level, so honour those
    // if present. Ciphertext still wins when both are supplied.
    const state = ProfileInitStateManager.buildInitialState({
      searchName: payload.linkedinCredentialsCiphertext ? null : (payload.searchName ?? null),
      searchPassword: payload.linkedinCredentialsCiphertext
        ? null
        : (payload.searchPassword ?? null),
      credentialsCiphertext: payload.linkedinCredentialsCiphertext,
      jwtToken,
      requestId,
      progressCallback: onProgress,
      // Consent flag (ADR-6): only an explicit true from the payload enables
      // mutual-connections collection; carried through into ingestion state.
      collectMutuals: payload.collectMutuals === true,
    });

    profileInitMonitor.startRequest(requestId, {
      username: 'not provided',
      recursionCount: 0,
      healPhase: undefined,
      isResuming: ProfileInitStateManager.isResumingState(state),
    });

    const result = await this.runProfileInitWithHealing(state);
    if (result === undefined) throw new Error('Profile initialization returned no result');

    profileInitMonitor.recordSuccess(requestId, result);
    return {
      statusCode: 200,
      ...this._buildSuccessResponse(result, requestId),
    };
  }
}
