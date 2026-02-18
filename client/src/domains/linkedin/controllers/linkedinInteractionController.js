import { logger } from '#utils/logger.js';
import { validateJwt } from '#utils/jwtValidator.js';
import { LinkedInInteractionService } from '../services/linkedinInteractionService.js';
import LinkedInService from '../services/linkedinService.js';
import LinkedInErrorHandler from '../utils/linkedinErrorHandler.js';
import LinkedInAuditLogger from '../utils/linkedinAuditLogger.js';
import ControlPlaneService from '../../../shared/services/controlPlaneService.js';
import { v4 as uuidv4 } from 'uuid';
import { linkedInInteractionQueue } from '../../automation/utils/interactionQueue.js';

// Shared singleton — same instance for all controller methods
const _controlPlaneService = new ControlPlaneService();

export class LinkedInInteractionController {
  /**
   * Send a direct message to a LinkedIn connection
   * POST /linkedin-interactions/send-message
   */
  async sendMessage(req, res) {
    const requestId = uuidv4();
    const startTime = Date.now();

    logger.info('LinkedIn send message request received', {
      requestId,
      hasToken: !!req.jwtToken,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });

    try {
      // Extract and validate request parameters
      const { recipientProfileId, messageContent, recipientName } = req.body;

      // Extract user ID from JWT token early for audit logging
      const userId = this._extractUserIdFromToken(req.jwtToken);

      const context = {
        operation: 'sendMessage',
        recipientProfileId,
        messageContent,
        messageLength: messageContent?.length,
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
        return res.status(httpStatus).json(response);
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
        return res.status(httpStatus).json(response);
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
        return res.status(httpStatus).json(response);
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
        return res.status(httpStatus).json(response);
      }

      // Enqueue the interaction to prevent concurrent page access
      const meta = { type: 'send-message', requestId, userId, recipientProfileId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        // Initialize LinkedIn interaction service
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        // Ensure we are logged in if no active authenticated session
        try {
          const sessionActive = await linkedinService.isSessionActive();
          if (!sessionActive) {
            const puppeteerService = await linkedinService.initializeBrowserSession();
            const credentialsCiphertext = req.body?.linkedinCredentialsCiphertext;
            const loginHelper = new LinkedInService(puppeteerService);
            await loginHelper.login(
              null,
              null,
              null,
              credentialsCiphertext,
              'interaction-controller'
            );
          }
        } catch (loginErr) {
          logger.error('LinkedIn login failed during message send', {
            error: loginErr.message,
            stack: loginErr.stack,
          });
          throw new Error(
            `Login required but failed to authenticate to LinkedIn: ${loginErr.message}`
          );
        }

        // Send message via service layer
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
    } catch (error) {
      const duration = Date.now() - startTime;
      const userId = this._extractUserIdFromToken(req.jwtToken);

      logger.error('Send message controller error:', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      // Log performance metrics even for failures
      LinkedInAuditLogger.logPerformanceMetrics(
        'sendMessage',
        duration,
        { operation: 'sendMessage' },
        requestId
      );

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        error,
        { operation: 'sendMessage', userId, duration },
        requestId
      );

      // Log interaction failure
      LinkedInAuditLogger.logInteractionFailure(
        'sendMessage',
        error,
        {
          operation: 'sendMessage',
          userId,
          duration,
          errorCategory: LinkedInErrorHandler.categorizeError(error).category,
        },
        requestId
      );

      return res.status(httpStatus).json(response);
    }
  }

  /**
   * Send a connection request to a LinkedIn profile
   * POST /linkedin-interactions/add-connection
   */
  async addConnection(req, res) {
    const requestId = uuidv4();
    logger.info('Add connection request received', { requestId });

    logger.info('LinkedIn add connection request received', {
      requestId,
      hasToken: !!req.jwtToken,
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
        return res.status(httpStatus).json(response);
      }
      logger.info('Add connection request received asdfsadfsadf1', { requestId, profileId });

      // Validate profile ID format (basic validation)
      if (typeof profileId !== 'string' || profileId.trim().length === 0) {
        const error = new Error('Invalid profile ID: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'addConnection', validation: 'profile_id_format' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Validate connection message length if provided
      // Do not process optional connection message in this controller; keep action focused
      logger.info('Add connection request received', { requestId, profileId });

      // Extract user ID from JWT token
      const userId = this._extractUserIdFromToken(req.jwtToken);
      if (!userId) {
        const error = new Error('JWT token invalid: unable to extract user ID from token');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'addConnection', authentication: 'jwt_extraction' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }
      logger.info('Add connection request received  2', { requestId, profileId });
      // Enqueue the interaction to prevent concurrent page access
      const meta = { type: 'add-connection', requestId, userId, profileId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        // Initialize LinkedIn interaction service
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        // Ensure we are logged in if no active authenticated session
        try {
          const sessionActive = await linkedinService.isSessionActive();
          if (!sessionActive) {
            const puppeteerService = await linkedinService.initializeBrowserSession();
            const credentialsCiphertext = req.body?.linkedinCredentialsCiphertext;
            const loginHelper = new LinkedInService(puppeteerService);
            await loginHelper.login(
              null,
              null,
              null,
              credentialsCiphertext,
              'interaction-controller'
            );
          }
        } catch (loginErr) {
          logger.error('LinkedIn login failed during connection request', {
            error: loginErr.message,
            stack: loginErr.stack,
          });
          throw new Error(
            `Login required but failed to authenticate to LinkedIn: ${loginErr.message}`
          );
        }

        // Send connection request via service layer (single workflow)
        logger.info('Attempting to send LinkedIn connection request', {
          requestId,
          profileId,
          userId,
        });
        return await linkedinService.executeConnectionWorkflow(profileId, '', {
          jwtToken: req.jwtToken,
        });
      }, meta);

      // Return success response
      res.json({
        success: true,
        data: {
          connectionRequestId: result.connectionRequestId,
          status: result.status || 'sent',
          profileId,
          sentAt: new Date().toISOString(),
          hasMessage: false,
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    } catch (error) {
      logger.error('Add connection controller error:', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        error,
        { operation: 'addConnection', userId: this._extractUserIdFromToken(req.jwtToken) },
        requestId
      );

      return res.status(httpStatus).json(response);
    }
  }

  /**
   * Create and publish a LinkedIn post
   * POST /linkedin-interactions/create-post
   */
  async createPost(req, res) {
    const requestId = uuidv4();

    logger.info('LinkedIn create post request received', {
      requestId,
      hasToken: !!req.jwtToken,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });

    try {
      // Extract and validate request parameters
      const { content, mediaAttachments } = req.body;

      // Validate required parameters
      if (!content) {
        const error = new Error('Missing required parameters: content is required');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'required_fields' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Validate content length (3000 character limit)
      if (content.length > 3000) {
        const error = new Error('Content exceeds maximum length: must be 3000 characters or less');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'content_length' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Validate content is not empty after trimming
      if (typeof content !== 'string' || content.trim().length === 0) {
        const error = new Error('Invalid post content: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'content_format' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Validate media attachments if provided
      if (mediaAttachments && !Array.isArray(mediaAttachments)) {
        const error = new Error('Invalid media attachments format: must be an array');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', validation: 'media_format' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Validate individual media attachments
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
            return res.status(httpStatus).json(response);
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
            return res.status(httpStatus).json(response);
          }
        }
      }

      // Extract user ID from JWT token
      const userId = this._extractUserIdFromToken(req.jwtToken);
      if (!userId) {
        const error = new Error('JWT token invalid: unable to extract user ID from token');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'createPost', authentication: 'jwt_extraction' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      const meta = { type: 'create-post', requestId, userId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        // Initialize LinkedIn interaction service
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

      // Return success response
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
    } catch (error) {
      logger.error('Create post controller error:', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        error,
        { operation: 'createPost', userId: this._extractUserIdFromToken(req.jwtToken) },
        requestId
      );

      return res.status(httpStatus).json(response);
    }
  }

  /**
   * Generate personalized message for a connection
   * POST /linkedin-interactions/generate-personalized-message
   */
  async generatePersonalizedMessage(req, res) {
    const requestId = uuidv4();

    logger.info('LinkedIn generate personalized message request received', {
      requestId,
      hasToken: !!req.jwtToken,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });

    try {
      // Extract and validate request parameters
      const { profileData, conversationTopic, messageHistory } = req.body;

      // Validate required parameters
      if (!profileData || !conversationTopic) {
        const error = new Error(
          'Missing required parameters: profileData and conversationTopic are required'
        );
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'generatePersonalizedMessage', validation: 'required_fields' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Extract user ID from JWT token
      const userId = this._extractUserIdFromToken(req.jwtToken);

      // NOTE: Personalized message generation not yet implemented
      logger.info('Personalized message generation not yet implemented', {
        requestId,
        hasProfileData: !!profileData,
        conversationTopic,
        hasMessageHistory: !!messageHistory,
        userId,
      });

      // Placeholder response
      res.json({
        success: true,
        data: {
          personalizedMessage: `Hi ${profileData.name || 'there'}, I'd love to discuss ${conversationTopic} with you.`,
          generatedAt: new Date().toISOString(),
        },
        message: 'Personalized message generation functionality not yet implemented',
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    } catch (error) {
      logger.error('Generate personalized message controller error:', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        error,
        {
          operation: 'generatePersonalizedMessage',
          userId: this._extractUserIdFromToken(req.jwtToken),
        },
        requestId
      );

      return res.status(httpStatus).json(response);
    }
  }

  /**
   * Follow a LinkedIn profile
   * POST /linkedin-interactions/follow-profile
   */
  async followProfile(req, res) {
    const requestId = uuidv4();

    logger.info('LinkedIn follow profile request received', {
      requestId,
      hasToken: !!req.jwtToken,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });

    try {
      // Extract and validate request parameters
      const { profileId } = req.body || {};

      // Validate required parameters
      if (!profileId) {
        const error = new Error('Missing required parameters: profileId is required');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'followProfile', validation: 'required_fields' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Validate profile ID format
      if (typeof profileId !== 'string' || profileId.trim().length === 0) {
        const error = new Error('Invalid profile ID: must be a non-empty string');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'followProfile', validation: 'profile_id_format' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Extract user ID from JWT token
      const userId = this._extractUserIdFromToken(req.jwtToken);
      if (!userId) {
        const error = new Error('JWT token invalid: unable to extract user ID from token');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'followProfile', authentication: 'jwt_extraction' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Enqueue the interaction to prevent concurrent page access
      const meta = { type: 'follow-profile', requestId, userId, profileId };
      const result = await linkedInInteractionQueue.enqueue(async () => {
        // Initialize LinkedIn interaction service
        const linkedinService = new LinkedInInteractionService({
          controlPlaneService: _controlPlaneService,
        });

        // Ensure we are logged in if no active authenticated session
        try {
          const sessionActive = await linkedinService.isSessionActive();
          if (!sessionActive) {
            const puppeteerService = await linkedinService.initializeBrowserSession();
            const credentialsCiphertext = req.body?.linkedinCredentialsCiphertext;
            const loginHelper = new LinkedInService(puppeteerService);
            await loginHelper.login(
              null,
              null,
              null,
              credentialsCiphertext,
              'interaction-controller'
            );
          }
        } catch (loginErr) {
          logger.error('LinkedIn login failed during follow profile', {
            error: loginErr.message,
            stack: loginErr.stack,
          });
          throw new Error(
            `Login required but failed to authenticate to LinkedIn: ${loginErr.message}`
          );
        }

        // Follow profile via service layer
        logger.info('Attempting to follow LinkedIn profile', { requestId, profileId, userId });
        return await linkedinService.followProfile(profileId, { jwtToken: req.jwtToken });
      }, meta);

      // Return success response
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
    } catch (error) {
      logger.error('Follow profile controller error:', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        error,
        { operation: 'followProfile', userId: this._extractUserIdFromToken(req.jwtToken) },
        requestId
      );

      return res.status(httpStatus).json(response);
    }
  }

  /**
   * Get current browser session status
   * GET /linkedin-interactions/session-status
   */
  async getSessionStatus(req, res) {
    const requestId = uuidv4();

    logger.info('LinkedIn session status request received', {
      requestId,
      hasToken: !!req.jwtToken,
    });

    try {
      // Extract user ID from JWT token
      const userId = this._extractUserIdFromToken(req.jwtToken);
      if (!userId) {
        const error = new Error('JWT token invalid: unable to extract user ID from token');
        const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
          error,
          { operation: 'getSessionStatus', authentication: 'jwt_extraction' },
          requestId
        );
        return res.status(httpStatus).json(response);
      }

      // Initialize LinkedIn interaction service
      const linkedinService = new LinkedInInteractionService({
        controlPlaneService: _controlPlaneService,
      });

      // Get comprehensive session status via service layer
      logger.info('Checking LinkedIn session status', { requestId, userId });

      const sessionStatus = await linkedinService.getSessionStatus();

      // Return session status response
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
            rss: sessionStatus.memoryUsage.rss,
            heapUsed: sessionStatus.memoryUsage.heapUsed,
            heapTotal: sessionStatus.memoryUsage.heapTotal,
            external: sessionStatus.memoryUsage.external,
          },
          currentUrl: sessionStatus.currentUrl,
        },
        timestamp: new Date().toISOString(),
        userId,
        requestId,
      });
    } catch (error) {
      logger.error('Session status controller error:', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      const { response, httpStatus } = LinkedInErrorHandler.createErrorResponse(
        error,
        { operation: 'getSessionStatus', userId: this._extractUserIdFromToken(req.jwtToken) },
        requestId
      );

      return res.status(httpStatus).json(response);
    }
  }

  /**
   * Extract user ID from JWT token with validation
   * Validates JWT structure, expiration, and required claims before extracting user ID.
   * @private
   */
  _extractUserIdFromToken(token) {
    const result = validateJwt(token);

    if (!result.valid) {
      logger.warn('JWT validation failed', { reason: result.reason });
      return null;
    }

    return result.userId;
  }

  /**
   * Transport-agnostic: send a message via WebSocket command.
   * @param {object} payload - { recipientProfileId, messageContent, recipientName, jwtToken }
   * @param {function} onProgress - progress callback
   */
  async sendMessageDirect(payload, _onProgress) {
    const fakeReq = {
      body: payload,
      jwtToken: payload.jwtToken,
      headers: { authorization: `Bearer ${payload.jwtToken || ''}` },
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

    await this.sendMessage(fakeReq, fakeRes);
    if (resultData?.error) {
      const err = new Error(resultData.error);
      err.code = 'SEND_MESSAGE_ERROR';
      throw err;
    }
    return resultData;
  }

  /**
   * Transport-agnostic: add a connection via WebSocket command.
   * @param {object} payload - { profileUrl, message, jwtToken }
   * @param {function} onProgress - progress callback
   */
  async addConnectionDirect(payload, _onProgress) {
    const fakeReq = {
      body: payload,
      jwtToken: payload.jwtToken,
      headers: { authorization: `Bearer ${payload.jwtToken || ''}` },
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

    await this.addConnection(fakeReq, fakeRes);
    if (resultData?.error) {
      const err = new Error(resultData.error);
      err.code = 'ADD_CONNECTION_ERROR';
      throw err;
    }
    return resultData;
  }
}

export default LinkedInInteractionController;
