import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionConnectionService } from './interactionConnectionService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      setAuthToken: vi.fn(),
      upsertEdgeStatus: vi.fn().mockResolvedValue(true),
    };
  }),
}));

vi.mock('../../session/services/browserSessionManager.js', () => ({
  BrowserSessionManager: {
    getInstance: vi.fn(),
    cleanup: vi.fn(),
    isSessionHealthy: vi.fn(),
    getHealthStatus: vi.fn(),
    getSessionMetrics: vi.fn().mockReturnValue({ recordOperation: vi.fn() }),
  },
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

vi.mock('#shared-config/configManager.js', () => ({
  default: {
    getErrorHandlingConfig: vi.fn().mockReturnValue({ retryAttempts: 3, retryBaseDelay: 1000 }),
    get: vi.fn((_key, def) => def),
  },
}));

vi.mock('#shared-config/index.js', () => ({
  default: { linkedin: { baseUrl: 'https://www.linkedin.com' } },
}));

describe('InteractionConnectionService', () => {
  let service;
  let mockPage;
  let mockNavService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = buildPuppeteerPage();
    const mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({ ok: () => true }),
      waitForSelector: vi.fn().mockResolvedValue({}),
    };
    BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

    mockNavService = {
      navigateToProfile: vi.fn().mockResolvedValue(true),
    };

    service = new InteractionConnectionService({
      interactionNavigationService: mockNavService,
    });
  });

  describe('executeConnectionWorkflow', () => {
    it('should execute full connection flow', async () => {
      vi.spyOn(service, 'getEarlyConnectionStatus').mockResolvedValue(null);
      vi.spyOn(service, 'isProfileContainer').mockResolvedValue(true);
      vi.spyOn(service, 'sendConnectionRequest').mockResolvedValue({
        requestId: 'r1',
        status: 'sent',
        confirmationFound: true,
      });

      const result = await service.executeConnectionWorkflow('p1', 'hi');

      expect(result.requestId).toBe('r1');
      expect(result.status).toBe('sent');
      expect(mockNavService.navigateToProfile).toHaveBeenCalledWith('p1');
    });

    it('should return early when already connected', async () => {
      vi.spyOn(service, 'getEarlyConnectionStatus').mockResolvedValue('ally');

      const result = await service.executeConnectionWorkflow('p1', 'hi');

      expect(result.status).toBe('ally');
    });

    it('should throw when navigation fails', async () => {
      mockNavService.navigateToProfile.mockResolvedValue(false);

      await expect(service.executeConnectionWorkflow('p1', 'hi')).rejects.toThrow(
        'Failed to navigate to profile'
      );
    });
  });

  describe('checkConnectionStatus', () => {
    it('should return connected when message button found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      const status = await service.checkConnectionStatus();
      expect(status).toBe('connected');
    });

    it('should return not_connected when no indicators found', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      const status = await service.checkConnectionStatus();
      expect(status).toBe('not_connected');
    });
  });

  describe('ensureEdge', () => {
    it('should set auth token and upsert edge', async () => {
      await service.ensureEdge('p1', 'outgoing', 'jwt-token');

      expect(service.dynamoDBService.setAuthToken).toHaveBeenCalledWith('jwt-token');
      expect(service.dynamoDBService.upsertEdgeStatus).toHaveBeenCalledWith('p1', 'outgoing');
    });

    it('should not throw on edge creation failure', async () => {
      service.dynamoDBService.upsertEdgeStatus.mockRejectedValue(new Error('failed'));

      await expect(service.ensureEdge('p1', 'outgoing', 'jwt')).resolves.not.toThrow();
    });
  });

  describe('createConnectionWorkflowResult', () => {
    it('should create standardized result', () => {
      const result = service.createConnectionWorkflowResult('p1', 'hello', {
        requestId: 'r1',
        status: 'sent',
      });
      expect(result.requestId).toBe('r1');
      expect(result.status).toBe('sent');
      expect(result.profileId).toBe('p1');
      expect(result.hasPersonalizedMessage).toBe(true);
    });
  });

  describe('getEarlyConnectionStatus', () => {
    it('should return null when no early status detected', async () => {
      vi.spyOn(service, 'isProfileContainer').mockResolvedValue(false);
      const status = await service.getEarlyConnectionStatus();
      expect(status).toBeNull();
    });
  });
});
