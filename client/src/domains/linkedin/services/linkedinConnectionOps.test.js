import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendConnectionRequest,
  checkConnectionStatus,
  ensureEdge,
  getEarlyConnectionStatus,
  createConnectionWorkflowResult,
  executeConnectionWorkflow,
} from './linkedinConnectionOps.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { mockResolver } = vi.hoisted(() => ({
  mockResolver: {
    resolve: vi.fn(),
    resolveWithWait: vi.fn(),
  },
}));

vi.mock('../selectors/index.js', () => ({
  linkedinResolver: mockResolver,
  linkedinSelectors: {},
}));

vi.mock('../utils/LinkedInError.js', () => ({
  LinkedInError: class extends Error {
    constructor(msg, code) {
      super(msg);
      this.code = code;
    }
  },
}));

describe('linkedinConnectionOps', () => {
  let mockService;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = {
      $: vi.fn(),
      evaluate: vi.fn(),
      evaluateHandle: vi.fn(),
    };
    const mockSession = { getPage: () => mockPage };
    mockService = {
      _enforceRateLimit: vi.fn(),
      _applyControlPlaneRateLimits: vi.fn().mockResolvedValue(undefined),
      _reportInteraction: vi.fn(),
      checkSuspiciousActivity: vi.fn().mockResolvedValue({ isSuspicious: false }),
      getBrowserSession: vi.fn().mockResolvedValue(mockSession),
      navigateToProfile: vi.fn().mockResolvedValue(true),
      isProfileContainer: vi.fn().mockResolvedValue(true),
      sendConnectionRequest: vi.fn().mockResolvedValue({
        requestId: 'r1',
        status: 'sent',
        confirmationFound: true,
      }),
      ensureEdge: vi.fn().mockResolvedValue(undefined),
      getEarlyConnectionStatus: vi.fn().mockResolvedValue(null),
      createConnectionWorkflowResult: vi
        .fn()
        .mockImplementation((profileId, msg, data) =>
          createConnectionWorkflowResult(profileId, msg, data)
        ),
      clickElementHumanly: vi.fn(),
      _paced: vi.fn((min, max, fn) => fn()),
      checkFollowStatus: vi.fn().mockResolvedValue(false),
      clickFollowButton: vi.fn().mockResolvedValue({ status: 'followed' }),
      sessionManager: {
        lastActivity: null,
        getSessionMetrics: vi.fn().mockReturnValue({ recordOperation: vi.fn() }),
      },
      humanBehavior: {
        recordAction: vi.fn(),
        simulateHumanMouseMovement: vi.fn(),
      },
      dynamoDBService: {
        setAuthToken: vi.fn(),
        upsertEdgeStatus: vi.fn().mockResolvedValue(true),
      },
    };
  });

  describe('sendConnectionRequest', () => {
    it('should send request and return result', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({ click: vi.fn() });

      const result = await sendConnectionRequest(mockService, 'p1', 'jwt-token');

      expect(result.status).toBe('sent');
      expect(result.confirmationFound).toBe(true);
    });

    it('should throw when modal does not appear', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('timeout'));
      await expect(sendConnectionRequest(mockService, 'p1')).rejects.toThrow();
    });
  });

  describe('checkConnectionStatus', () => {
    it('should return connected when message button found', async () => {
      mockResolver.resolveWithWait.mockResolvedValueOnce({}); // message button
      const result = await checkConnectionStatus(mockService);
      expect(result).toBe('connected');
    });

    it('should return not_connected when nothing found', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      const result = await checkConnectionStatus(mockService);
      expect(result).toBe('not_connected');
    });
  });

  describe('ensureEdge', () => {
    it('should set auth token and upsert edge', async () => {
      await ensureEdge(mockService, 'p1', 'connected', 'jwt-123');
      expect(mockService.dynamoDBService.setAuthToken).toHaveBeenCalledWith('jwt-123');
      expect(mockService.dynamoDBService.upsertEdgeStatus).toHaveBeenCalledWith('p1', 'connected');
    });

    it('should skip auth token when not provided', async () => {
      await ensureEdge(mockService, 'p1', 'connected');
      expect(mockService.dynamoDBService.setAuthToken).not.toHaveBeenCalled();
    });
  });

  describe('getEarlyConnectionStatus', () => {
    it('should return ally when connection-degree matches', async () => {
      mockService.isProfileContainer.mockResolvedValueOnce(true); // connection-degree
      const result = await getEarlyConnectionStatus(mockService);
      expect(result).toBe('ally');
    });

    it('should return null when nothing matches', async () => {
      mockService.isProfileContainer.mockResolvedValue(false);
      const result = await getEarlyConnectionStatus(mockService);
      expect(result).toBeNull();
    });
  });

  describe('createConnectionWorkflowResult', () => {
    it('should create standardized result', () => {
      const result = createConnectionWorkflowResult('p1', 'hello', {
        requestId: 'r1',
        status: 'sent',
      });
      expect(result.profileId).toBe('p1');
      expect(result.hasPersonalizedMessage).toBe(true);
      expect(result.status).toBe('sent');
    });
  });

  describe('executeConnectionWorkflow', () => {
    it('should execute full workflow', async () => {
      const result = await executeConnectionWorkflow(mockService, 'p1', 'hi');
      expect(result.status).toBe('sent');
      expect(mockService._reportInteraction).toHaveBeenCalledWith('executeConnectionWorkflow');
    });
  });
});
