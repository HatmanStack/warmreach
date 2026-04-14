import { logger } from '#utils/logger.js';
import { validateJwt } from '#utils/jwtValidator.js';
import { LinkedInInteractionService } from '../services/linkedinInteractionService.js';
import { LinkedInService } from '../services/linkedinService.js';
import { LinkedInErrorHandler } from '../utils/linkedinErrorHandler.js';
import { LinkedInAuditLogger } from '../utils/linkedinAuditLogger.js';
import ControlPlaneService from '../../../shared/services/controlPlaneService.js';
import { v4 as uuidv4 } from 'uuid';
import { linkedInInteractionQueue } from '../../automation/utils/interactionQueue.js';
import type { Request, Response } from 'express';

interface DirectMessagePayload {
  jwtToken?: string;
  recipientProfileId?: string;
  messageContent?: string;
  recipientName?: string;
  linkedinCredentialsCiphertext?: string;
}

interface DirectConnectionPayload {
  jwtToken?: string;
  profileId?: string;
  profileUrl?: string;
  message?: string;
  linkedinCredentialsCiphertext?: string;
}

interface JwtResult {
  valid: boolean;
  reason?: string;
  userId?: string;
}

// Shared singleton — same instance for all controller methods
const _controlPlaneService = new ControlPlaneService();

/**
 * Helper to access the jwtToken property set by middleware on Express requests.
 * The middleware (in routes/linkedinInteractionRoutes.js) assigns req.jwtToken.
 */
function getJwtToken(req: Request): string | undefined {
  return (req as unknown as Record<string, unknown>).jwtToken as string | undefined;
}

/** Narrow an unknown caught value to an Error-like shape for logging. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class LinkedInInteractionController {
  /**
   * Send a direct message to a LinkedIn connection
   * POST /linkedin-interactions/send-message
   */
  async sendMessage(req: Request, res: Response): Promise<void> {
    const requestId = uuidv4();
    const startTime = Date.now();

    logger.info('LinkedIn send message request received', {
      requestId,
      hasToken: !!getJwtToken(req),
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });

    try {
      // Extract and validate request parameters
      const { recipientProfileId, messageContent, recipientName } = req.body;

      // Extract user ID from JWT token early for audit logging
      const userId = this._extractUserIdFromToken(getJwtToken(req));

      const context = {
        operation: 'sendMessage',
        recipientProfileId,
        messageContent,
        messageLength: messageContent?.length as number | undefined,
        userId,
        recipientName,
      };

      // Log interaction attempt
      LinkedInAuditLogger.logInteractionAttempt('sendMessage', context, requestId);

      // Validate required parameters
      if (!recipientProfileId || !messageContent) {
        const error = new Error(
          'Missing required parameters: recipientProfileId and messageContent are required'
        );
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { ...context, validation: 'required_fields' },
          requestId
        );

        LinkedInAuditLogger.logInteractionFailure('sendMessage', error, context, requestId);
        res.status(httpStatus).json(response);
        return;
      }

      // Validate message content length (reasonable limit)
      if (messageContent.length > 8000) {
        const error = new Error('Message content too long: must be 8000 characters or less');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { ...context, validation: 'content_length' },
          requestId
        );

        LinkedInAuditLogger.logInteractionFailure('sendMessage', error, context, requestId);
        res.status(httpStatus).json(response);
        return;
      }

      // Validate profile ID format (basic validation)
      if (typeof recipientProfileId !== 'string' || recipientProfileId.trim().length === 0) {
        const error = new Error('Invalid profile ID: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { ...context, validation: 'profile_id_format' },
          requestId
        );

        LinkedInAuditLogger.logInteractionFailure('sendMessage', error, context, requestId);
        res.status(httpStatus).json(response);
        return;
      }

      if (!userId) {
        const error = new Error('JWT token invalid: unable to extract user ID from token');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { ...context, authentication: 'jwt_extraction' },
          requestId
        );

        LinkedInAuditLogger.logAuthenticationEvent(
          'failure',
          { userId, jwtValid: false },
          requestId
        );
        LinkedInAuditLogger.logInteractionFailure('sendMessage', error, context, requestId);
        res.status(httpStatus).json(response);
        return;
      }

      // Enqueue the interaction to prevent concurrent page access
      const meta = { type: 'send-message', requestId, userId, recipientProfileId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        try {
          await this._ensureLinkedInAuth(
            linkedinService,
            req.body?.linkedinCredentialsCiphertext,
            'sendMessage'
          );
        } catch (loginErr: unknown) {
          const loginError = toError(loginErr);
          logger.error('LinkedIn login failed during message send', {
            error: loginError.message,
            stack: loginError.stack,
          });
          throw new Error(
            `Login required but failed to authenticate to LinkedIn: ${loginError.message}`
          );
        }

        logger.info('Attempting to send LinkedIn message', {
          requestId,
          recipientProfileId,
          messageLength: messageContent.length,
          userId,
          recipientName,
        });

        return await linkedinService.sendMessage(recipientProfileId, messageContent, userId);
      }, meta);

      const duration = Date.now() - startTime;

      // Log performance metrics
      LinkedInAuditLogger.logPerformanceMetrics('sendMessage', duration, context, requestId);

      // Log successful interaction
      LinkedInAuditLogger.logInteractionSuccess(
        'sendMessage',
        result,
        { ...context, duration },
        requestId
      );

      // Return success response
      res.json({
        success: true,
        data: {
          messageId: result.messageId,
          deliveryStatus: result.deliveryStatus || 'sent',
          recipientProfileId,
          sentAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const userId = this._extractUserIdFromToken(getJwtToken(req));
      const errorObj = toError(error);

      logger.error('Send message controller error:', {
        requestId,
        error: errorObj.message,
        stack: errorObj.stack,
      });

      // Log performance metrics even for failures
      LinkedInAuditLogger.logPerformanceMetrics(
        'sendMessage',
        duration,
        { operation: 'sendMessage' },
        requestId
      );

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        errorObj,
        { operation: 'sendMessage', userId, duration },
        requestId
      );

      // Log interaction failure
      LinkedInAuditLogger.logInteractionFailure(
        'sendMessage',
        errorObj,
        {
          operation: 'sendMessage',
          userId,
          duration,
          errorCategory: LinkedInErrorHandler.categorizeError(errorObj).category,
        },
        requestId
      );

      res.status(httpStatus).json(response);
    }
  }

  /**
   * Send a connection request to a LinkedIn profile
   * POST /linkedin-interactions/add-connection
   */
  async addConnection(req: Request, res: Response): Promise<void> {
    const requestId = uuidv4();
    logger.info('LinkedIn add connection request received', {
      requestId,
      hasToken: !!getJwtToken(req),
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });

    try {
      // Extract and validate request parameters (minimal subset)
      const { profileId } = req.body || {};

      // Validate required parameters
      if (!profileId) {
        const error = new Error('Missing required parameters: profileId is required');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'addConnection', validation: 'required_fields' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }
      logger.info('Add connection request received', { requestId, profileId });

      // Validate profile ID format (basic validation)
      if (typeof profileId !== 'string' || profileId.trim().length === 0) {
        const error = new Error('Invalid profile ID: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'addConnection', validation: 'profile_id_format' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      // Extract user ID from JWT token
      const userId = this._extractUserIdFromToken(getJwtToken(req));
      if (!userId) {
        const error = new Error('JWT token invalid: unable to extract user ID from token');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'addConnection', authentication: 'jwt_extraction' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }
      // Enqueue the interaction to prevent concurrent page access
      const meta = { type: 'add-connection', requestId, userId, profileId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        try {
          await this._ensureLinkedInAuth(
            linkedinService,
            req.body?.linkedinCredentialsCiphertext,
            'addConnection'
          );
        } catch (loginErr: unknown) {
          const loginError = toError(loginErr);
          logger.error('LinkedIn login failed during connection request', {
            error: loginError.message,
            stack: loginError.stack,
          });
          throw new Error(
            `Login required but failed to authenticate to LinkedIn: ${loginError.message}`
          );
        }

        logger.info('Attempting to send LinkedIn connection request', {
          requestId,
          profileId,
          userId,
        });
        return await linkedinService.executeConnectionWorkflow(profileId, '', {
          jwtToken: getJwtToken(req),
        });
      }, meta);

      // Return success response
      res.json({
        success: true,
        data: {
          connectionRequestId: result.requestId,
          status: result.status || 'sent',
          profileId,
          sentAt: new Date().toISOString(),
          hasMessage: false,
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    } catch (error: unknown) {
      const errorObj = toError(error);
      logger.error('Add connection controller error:', {
        requestId,
        error: errorObj.message,
        stack: errorObj.stack,
      });

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        errorObj,
        { operation: 'addConnection', userId: this._extractUserIdFromToken(getJwtToken(req)) },
        requestId
      );

      res.status(httpStatus).json(response);
    }
  }

  /**
   * Create and publish a LinkedIn post
   * POST /linkedin-interactions/create-post
   */
  createPost = this._withAuthenticatedSession(
    'createPost',
    async (req, res, { requestId, userId }): Promise<void> => {
      const { content, mediaAttachments } = req.body;

      // Validate required parameters
      if (!content) {
        const error = new Error('Missing required parameters: content is required');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'required_fields' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      if (content.length > 3000) {
        const error = new Error('Content exceeds maximum length: must be 3000 characters or less');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'content_length' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      if (typeof content !== 'string' || content.trim().length === 0) {
        const error = new Error('Invalid post content: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'content_format' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      if (mediaAttachments && !Array.isArray(mediaAttachments)) {
        const error = new Error('Invalid media attachments format: must be an array');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'media_format' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      if (mediaAttachments && mediaAttachments.length > 0) {
        for (let i = 0; i < mediaAttachments.length; i++) {
          const attachment = mediaAttachments[i];
          if (!attachment.type || !attachment.url || !attachment.filename) {
            const error = new Error(
              `Invalid media attachment format: attachment ${i + 1} must have type, url, and filename properties`
            );
            const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
              error,
              { operation: 'createPost', validation: 'media_attachment_fields' },
              requestId
            );
            res.status(httpStatus).json(response);
            return;
          }

          if (!['image', 'video', 'document'].includes(attachment.type)) {
            const error = new Error(
              `Invalid media attachment type: attachment ${i + 1} type must be 'image', 'video', or 'document'`
            );
            const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
              error,
              { operation: 'createPost', validation: 'media_attachment_type' },
              requestId
            );
            res.status(httpStatus).json(response);
            return;
          }
        }
      }

      const meta = { type: 'create-post', requestId, userId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        logger.info('Attempting to create LinkedIn post', {
          requestId,
          contentLength: content.length,
          hasMediaAttachments: !!mediaAttachments && mediaAttachments.length > 0,
          mediaCount: mediaAttachments ? mediaAttachments.length : 0,
          userId,
        });

        return await linkedinService.createPost(content, mediaAttachments || [], userId);
      }, meta);

      res.json({
        success: true,
        data: {
          postId: result.postId,
          postUrl: result.postUrl,
          publishStatus: result.publishStatus || 'published',
          publishedAt: result.publishedAt,
          contentLength: content.length,
          mediaCount: mediaAttachments ? mediaAttachments.length : 0,
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    }
  );

  /**
   * Follow a LinkedIn profile
   * POST /linkedin-interactions/follow-profile
   */
  followProfile = this._withAuthenticatedSession(
    'followProfile',
    async (req, res, { requestId, userId }): Promise<void> => {
      const { profileId } = req.body || {};

      // Validate required parameters
      if (!profileId) {
        const error = new Error('Missing required parameters: profileId is required');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'followProfile', validation: 'required_fields' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      // Validate profile ID format
      if (typeof profileId !== 'string' || profileId.trim().length === 0) {
        const error = new Error('Invalid profile ID: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'followProfile', validation: 'profile_id_format' },
          requestId
        );
        res.status(httpStatus).json(response);
        return;
      }

      // Enqueue the interaction to prevent concurrent page access
      const meta = { type: 'follow-profile', requestId, userId, profileId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        try {
          await this._ensureLinkedInAuth(
            linkedinService,
            req.body?.linkedinCredentialsCiphertext,
            'followProfile'
          );
        } catch (loginErr: unknown) {
          const loginError = toError(loginErr);
          logger.error('LinkedIn login failed during follow profile', {
            error: loginError.message,
            stack: loginError.stack,
          });
          throw new Error(
            `Login required but failed to authenticate to LinkedIn: ${loginError.message}`
          );
        }

        logger.info('Attempting to follow LinkedIn profile', { requestId, profileId, userId });
        return await linkedinService.followProfile(profileId, { jwtToken: getJwtToken(req) });
      }, meta);

      res.json({
        success: true,
        data: {
          status: result.status,
          profileId,
          followedAt: result.followedAt,
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    }
  );

  /**
   * Get current browser session status
   * GET /linkedin-interactions/session-status
   */
  getSessionStatus = this._withAuthenticatedSession(
    'getSessionStatus',
    async (_req: Request, res: Response, { requestId, userId }): Promise<void> => {
      const linkedinService = new LinkedInInteractionService({
        controlPlaneService: _controlPlaneService,
      });

      logger.info('Checking LinkedIn session status', { requestId, userId });

      const sessionStatus = await linkedinService.getSessionStatus();

      const memoryUsage = sessionStatus.memoryUsage ?? {
        rss: 0,
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
      };

      res.json({
        success: true,
        data: {
          isActive: sessionStatus.isActive,
          isHealthy: sessionStatus.isHealthy,
          isAuthenticated: sessionStatus.isAuthenticated,
          lastActivity: sessionStatus.lastActivity,
          sessionAge: sessionStatus.sessionAge,
          errorCount: sessionStatus.errorCount,
          memoryUsage: {
            rss: memoryUsage.rss,
            heapUsed: memoryUsage.heapUsed,
            heapTotal: memoryUsage.heapTotal,
            external: memoryUsage.external,
          },
          currentUrl: sessionStatus.currentUrl,
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    }
  );

  /**
   * Ensure LinkedIn session is active and authenticated, logging in if needed.
   */
  async _ensureLinkedInAuth(
    linkedinService: LinkedInInteractionService,
    credentialsCiphertext: string | undefined,
    _operationName: string
  ): Promise<void> {
    const sessionActive = await linkedinService.isSessionActive();
    if (sessionActive) return;

    const puppeteerService = await linkedinService.initializeBrowserSession();
    const loginHelper = new LinkedInService(
      puppeteerService as ConstructorParameters<typeof LinkedInService>[0]
    );
    await loginHelper.login(
      null,
      null,
      false,
      credentialsCiphertext ?? null,
      'interaction-controller'
    );
  }

  /**
   * Shared wrapper that handles auth/session/error boilerplate for controller methods.
   */
  _withAuthenticatedSession(
    operationName: string,
    handler: (
      req: Request,
      res: Response,
      ctx: { requestId: string; userId: string }
    ) => Promise<void>
  ) {
    return async (req: Request, res: Response): Promise<void> => {
      const requestId = uuidv4();

      logger.info(`LinkedIn ${operationName} request received`, {
        requestId,
        hasToken: !!getJwtToken(req),
        bodyKeys: req.body ? Object.keys(req.body) : 'no body',
      });

      try {
        const userId = this._extractUserIdFromToken(getJwtToken(req));
        if (!userId) {
          const error = new Error('JWT token invalid: unable to extract user ID from token');
          const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
            error,
            { operation: operationName, authentication: 'jwt_extraction' },
            requestId
          );
          res.status(httpStatus).json(response);
          return;
        }

        await handler(req, res, { requestId, userId });
      } catch (error: unknown) {
        const errorObj = toError(error);
        logger.error(`${operationName} controller error:`, {
          requestId,
          error: errorObj.message,
          stack: errorObj.stack,
        });

        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          errorObj,
          { operation: operationName, userId: this._extractUserIdFromToken(getJwtToken(req)) },
          requestId
        );

        res.status(httpStatus).json(response);
      }
    };
  }

  /**
   * Extract user ID from JWT token with validation.
   * Validates JWT structure, expiration, and required claims before extracting user ID.
   */
  _extractUserIdFromToken(token: string | undefined): string | null {
    // validateJwt (JS module) handles undefined/null tokens gracefully
    const result = validateJwt(token as string) as JwtResult;

    if (!result.valid) {
      logger.warn('JWT validation failed', { reason: result.reason });
      return null;
    }

    return result.userId ?? null;
  }

  /**
   * Transport-agnostic: send a message via WebSocket command.
   * Calls the service layer directly instead of simulating an HTTP request.
   */
  async sendMessageDirect(
    payload: DirectMessagePayload,
    _onProgress?: (...args: unknown[]) => void
  ) {
    const requestId = uuidv4();
    const userId = this._extractUserIdFromToken(payload.jwtToken);
    if (!userId) {
      const err: Error & { code?: string } = new Error(
        'JWT token invalid: unable to extract user ID from token'
      );
      err.code = 'SEND_MESSAGE_ERROR';
      throw err;
    }

    const { recipientProfileId, messageContent } = payload;
    if (!recipientProfileId || !messageContent) {
      const err: Error & { code?: string } = new Error(
        'Missing required parameters: recipientProfileId and messageContent are required'
      );
      err.code = 'SEND_MESSAGE_ERROR';
      throw err;
    }

    const meta = { type: 'send-message', requestId, userId, recipientProfileId };
    const result = await linkedInInteractionQueue.enqueue(async () => {
      const linkedinService = new LinkedInInteractionService({
        controlPlaneService: _controlPlaneService,
      });

      await this._ensureLinkedInAuth(
        linkedinService,
        payload.linkedinCredentialsCiphertext,
        'sendMessageDirect'
      );

      return await linkedinService.sendMessage(recipientProfileId, messageContent, userId);
    }, meta);

    return {
      statusCode: 200,
      success: true,
      data: {
        messageId: result.messageId,
        deliveryStatus: result.deliveryStatus || 'sent',
        recipientProfileId,
        sentAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
      userId,
      requestId,
    };
  }

  /**
   * Transport-agnostic: add a connection via WebSocket command.
   * Calls the service layer directly instead of simulating an HTTP request.
   */
  async addConnectionDirect(
    payload: DirectConnectionPayload,
    _onProgress?: (...args: unknown[]) => void
  ) {
    const requestId = uuidv4();
    const userId = this._extractUserIdFromToken(payload.jwtToken);
    if (!userId) {
      const err: Error & { code?: string } = new Error(
        'JWT token invalid: unable to extract user ID from token'
      );
      err.code = 'ADD_CONNECTION_ERROR';
      throw err;
    }

    const profileId = payload.profileId;
    if (!profileId) {
      const err: Error & { code?: string } = new Error(
        'Missing required parameters: profileId is required'
      );
      err.code = 'ADD_CONNECTION_ERROR';
      throw err;
    }

    const meta = { type: 'add-connection', requestId, userId, profileId };
    const result = await linkedInInteractionQueue.enqueue(async () => {
      const linkedinService = new LinkedInInteractionService({
        controlPlaneService: _controlPlaneService,
      });

      await this._ensureLinkedInAuth(
        linkedinService,
        payload.linkedinCredentialsCiphertext,
        'addConnectionDirect'
      );

      return await linkedinService.executeConnectionWorkflow(profileId, '', {
        jwtToken: payload.jwtToken,
      });
    }, meta);

    return {
      statusCode: 200,
      success: true,
      data: {
        connectionRequestId: result.requestId,
        status: result.status || 'sent',
        profileId,
        sentAt: new Date().toISOString(),
        hasMessage: false,
      },
      timestamp: new Date().toISOString(),
      userId,
      requestId,
    };
  }
}

