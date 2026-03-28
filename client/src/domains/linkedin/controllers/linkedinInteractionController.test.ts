import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInInteractionController } from './linkedinInteractionController.js';
import { LinkedInInteractionService } from '../services/linkedinInteractionService.js';
import { LinkedInService } from '../services/linkedinService.js';
import { LinkedInErrorHandler } from '../utils/linkedinErrorHandler.js';
import { LinkedInAuditLogger } from '../utils/linkedinAuditLogger.js';
import { linkedInInteractionQueue } from '../../automation/utils/interactionQueue.js';
import { validateJwt } from '#utils/jwtValidator.js';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#utils/jwtValidator.js', () => ({
  validateJwt: vi.fn(),
}));

vi.mock('../services/linkedinInteractionService.js', () => ({
  LinkedInInteractionService: vi.fn().mockImplementation(function () {
    return {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-123', deliveryStatus: 'sent' }),
      executeConnectionWorkflow: vi
        .fn()
        .mockResolvedValue({ connectionRequestId: 'conn-123', status: 'sent' }),
      isSessionActive: vi.fn().mockResolvedValue(true),
      initializeBrowserSession: vi.fn().mockResolvedValue({}),
      getSessionStatus: vi.fn().mockResolvedValue({
        isActive: true,
        isHealthy: true,
        isAuthenticated: true,
        lastActivity: new Date(),
        sessionAge: 1000,
        errorCount: 0,
        memoryUsage: { rss: 100, heapUsed: 50, heapTotal: 80, external: 10 },
        currentUrl: 'https://linkedin.com',
      }),
    };
  }),
}));

vi.mock('../services/linkedinService.js', () => ({
  LinkedInService: vi.fn().mockImplementation(function () {
    return {
      login: vi.fn().mockResolvedValue(true),
    };
  }),
}));

vi.mock('../utils/linkedinErrorHandler.js', () => ({
  LinkedInErrorHandler: {
    createErrorResponse: vi
      .fn()
      .mockReturnValue({ response: { error: 'mock error' }, httpStatus: 500 }),
    categorizeError: vi.fn().mockReturnValue({ category: 'UNEXPECTED' }),
  },
}));

vi.mock('../utils/linkedinAuditLogger.js', () => ({
  LinkedInAuditLogger: {
    logInteractionAttempt: vi.fn(),
    logInteractionSuccess: vi.fn(),
    logInteractionFailure: vi.fn(),
    logAuthenticationEvent: vi.fn(),
    logPerformanceMetrics: vi.fn(),
  },
}));

vi.mock('../../automation/utils/interactionQueue.js', () => ({
  linkedInInteractionQueue: {
    enqueue: vi.fn().mockImplementation((fn) => fn()),
  },
}));

vi.mock('../../../shared/services/controlPlaneService.js', () => ({
  default: vi.fn(),
}));

describe('LinkedInInteractionController', () => {
  let controller;
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new LinkedInInteractionController();

    mockReq = {
      jwtToken: 'valid-token',
      body: {
        recipientProfileId: 'profile-123',
        messageContent: 'Hello world',
        profileId: 'profile-123',
      },
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    validateJwt.mockReturnValue({ valid: true, userId: 'user-123' });

    // Default implementations
    LinkedInInteractionService.mockImplementation(function () {
      return {
        sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-123', deliveryStatus: 'sent' }),
        executeConnectionWorkflow: vi
          .fn()
          .mockResolvedValue({ connectionRequestId: 'conn-123', status: 'sent' }),
        isSessionActive: vi.fn().mockResolvedValue(true),
        initializeBrowserSession: vi.fn().mockResolvedValue({}),
        getSessionStatus: vi.fn().mockResolvedValue({
          isActive: true,
          isHealthy: true,
          isAuthenticated: true,
          lastActivity: new Date(),
          sessionAge: 1000,
          errorCount: 0,
          memoryUsage: { rss: 100, heapUsed: 50, heapTotal: 80, external: 10 },
          currentUrl: 'https://linkedin.com',
        }),
      };
    });

    LinkedInService.mockImplementation(function () {
      return {
        login: vi.fn().mockResolvedValue(true),
      };
    });

    linkedInInteractionQueue.enqueue.mockImplementation(async (fn) => await fn());

    // Set default return value for ErrorHandler
    LinkedInErrorHandler.createErrorResponse.mockImplementation((error) => ({
      response: { error: error.message },
      httpStatus: 500,
    }));
    LinkedInErrorHandler.categorizeError.mockReturnValue({ category: 'UNEXPECTED' });
  });

  describe('sendMessage', () => {
    it('should send message successfully', async () => {
      await controller.sendMessage(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            messageId: 'msg-123',
          }),
        })
      );
      expect(LinkedInAuditLogger.logInteractionSuccess).toHaveBeenCalled();
    });

    it('should return 400 if required parameters are missing', async () => {
      mockReq.body.messageContent = '';

      LinkedInErrorHandler.createErrorResponse.mockReturnValue({
        response: { error: 'Missing parameters' },
        httpStatus: 400,
      });

      await controller.sendMessage(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(LinkedInAuditLogger.logInteractionFailure).toHaveBeenCalled();
    });

    it('should handle login if session is not active', async () => {
      // Create a specific mock instance for this test
      const mockSendMessage = vi.fn().mockResolvedValue({ messageId: 'msg-123' });
      LinkedInInteractionService.mockImplementation(function () {
        return {
          isSessionActive: vi.fn().mockResolvedValue(false),
          initializeBrowserSession: vi.fn().mockResolvedValue({}),
          sendMessage: mockSendMessage,
        };
      });

      await controller.sendMessage(mockReq, mockRes);

      expect(LinkedInService).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalled();
    });
  });

  describe('addConnection', () => {
    it('should execute connection workflow successfully', async () => {
      await controller.addConnection(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            connectionRequestId: 'conn-123',
          }),
        })
      );
    });
  });

  describe('getSessionStatus', () => {
    it('should return session status', async () => {
      await controller.getSessionStatus(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            isActive: true,
          }),
        })
      );
    });
  });

  describe('_withAuthenticatedSession', () => {
    it('should exist as a method on the controller', () => {
      expect(typeof controller._withAuthenticatedSession).toBe('function');
    });

    it('should return an async function', () => {
      const wrapped = controller._withAuthenticatedSession('testOp', vi.fn());
      expect(typeof wrapped).toBe('function');
    });

    it('should return error response when JWT is invalid', async () => {
      validateJwt.mockReturnValue({ valid: false, reason: 'expired' });
      LinkedInErrorHandler.createErrorResponse.mockReturnValue({
        response: { error: 'JWT invalid' },
        httpStatus: 401,
      });

      const handler = vi.fn();
      const wrapped = controller._withAuthenticatedSession('testOp', handler);
      await wrapped(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should call handler with context on valid JWT', async () => {
      const handler = vi.fn();
      const wrapped = controller._withAuthenticatedSession('testOp', handler);
      await wrapped(mockReq, mockRes);

      expect(handler).toHaveBeenCalledWith(
        mockReq,
        mockRes,
        expect.objectContaining({
          requestId: expect.any(String),
          userId: 'user-123',
        })
      );
    });

    it('should catch handler errors and return error response', async () => {
      LinkedInErrorHandler.createErrorResponse.mockReturnValue({
        response: { error: 'Something broke' },
        httpStatus: 500,
      });

      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      const wrapped = controller._withAuthenticatedSession('testOp', handler);
      await wrapped(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });
});
