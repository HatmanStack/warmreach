import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileInitController } from './profileInitController.js';
import { ProfileInitService } from '../services/profileInitService.js';
import { HealingManager } from '../../automation/utils/healingManager.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { profileInitMonitor } from '../utils/profileInitMonitor.js';
import { validateLinkedInCredentials } from '../../../shared/utils/credentialValidator.js';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../shared/utils/serviceFactory.js', () => ({
  initializeLinkedInServices: vi.fn().mockResolvedValue({
    linkedInService: {},
    linkedInContactService: {},
    dynamoDBService: { setAuthToken: vi.fn() },
    puppeteerService: {},
  }),
  cleanupLinkedInServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/utils/credentialValidator.js', () => ({
  validateLinkedInCredentials: vi.fn(),
}));

vi.mock('../services/profileInitService.js', () => ({
  ProfileInitService: vi.fn().mockImplementation(function () {
    return {
      initializeUserProfile: vi.fn().mockResolvedValue({ profileId: 'user-123' }),
    };
  }),
}));

vi.mock('../../automation/utils/healingManager.js', () => ({
  HealingManager: vi.fn().mockImplementation(function () {
    return {
      healAndRestart: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('../utils/profileInitStateManager.js', () => ({
  ProfileInitStateManager: {
    buildInitialState: vi.fn().mockReturnValue({}),
    isResumingState: vi.fn().mockReturnValue(false),
    createHealingState: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../utils/profileInitMonitor.js', () => ({
  profileInitMonitor: {
    startRequest: vi.fn(),
    recordHealing: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

describe('ProfileInitController', () => {
  let controller;
  let mockReq;
  let mockRes;

  beforeEach(async () => {
    vi.resetAllMocks();
    controller = new ProfileInitController();

    mockReq = {
      headers: { authorization: 'Bearer test-token' },
      body: {
        linkedinCredentialsCiphertext: 'encrypted',
      },
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    validateLinkedInCredentials.mockReturnValue({ isValid: true });

    ProfileInitStateManager.buildInitialState.mockReturnValue({
      jwtToken: 'test-token',
      requestId: 'test-request-id',
      recursionCount: 0,
    });

    ProfileInitStateManager.createHealingState.mockReturnValue({
      recursionCount: 1,
      healPhase: 'profile-init',
      healReason: 'test',
    });

    const { initializeLinkedInServices } = await import('../../../shared/utils/serviceFactory.js');
    initializeLinkedInServices.mockResolvedValue({
      linkedInService: {},
      linkedInContactService: {},
      dynamoDBService: { setAuthToken: vi.fn() },
      puppeteerService: {},
    });

    ProfileInitService.mockImplementation(function () {
      return {
        initializeUserProfile: vi.fn().mockResolvedValue({ profileId: 'user-123' }),
      };
    });

    HealingManager.mockImplementation(function () {
      return {
        healAndRestart: vi.fn().mockResolvedValue(undefined),
      };
    });
  });

  describe('performProfileInit', () => {
    it('should return 401 if JWT token is missing', async () => {
      mockReq.headers.authorization = undefined;

      await controller.performProfileInit(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('should return 400 if validation fails', async () => {
      validateLinkedInCredentials.mockReturnValue({
        isValid: false,
        statusCode: 400,
        error: 'Invalid credentials',
      });

      await controller.performProfileInit(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should execute full init flow successfully', async () => {
      await controller.performProfileInit(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            profileData: expect.any(Object),
          }),
        })
      );
      expect(profileInitMonitor.recordSuccess).toHaveBeenCalled();
    });

    it('should return 202 status when healing is triggered', async () => {
      // Mock ProfileInitService to throw a recoverable error
      ProfileInitService.mockImplementation(function () {
        return {
          initializeUserProfile: vi.fn().mockRejectedValue(new Error('navigation failed')),
        };
      });

      await controller.performProfileInit(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healing',
        })
      );
    });

    it('should handle errors with 500 status', async () => {
      // Force error in a nested call
      vi.spyOn(controller, 'performProfileInitFromState').mockRejectedValue(
        new Error('Init failed')
      );

      await controller.performProfileInit(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(profileInitMonitor.recordFailure).toHaveBeenCalled();
    });
  });

  describe('initializeDirect', () => {
    it('should return result data on success', async () => {
      vi.spyOn(controller, 'performProfileInitFromState').mockResolvedValue({
        profileData: { id: '123' },
      });

      const payload = { jwtToken: 'token' };
      const result = await controller.initializeDirect(payload, vi.fn());

      expect(result.statusCode).toBe(200);
      expect(result.status).toBe('success');
    });
  });
});
