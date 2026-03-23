import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionFollowService } from './interactionFollowService.js';
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

describe('InteractionFollowService', () => {
  let service;
  let mockPage;
  let mockNavService;
  let mockConnService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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

    mockConnService = {
      ensureEdge: vi.fn().mockResolvedValue(undefined),
      isProfileContainer: vi.fn().mockResolvedValue(false),
    };

    service = new InteractionFollowService({
      interactionNavigationService: mockNavService,
      interactionConnectionService: mockConnService,
    });
  });

  describe('followProfile', () => {
    it('should follow profile successfully', async () => {
      vi.spyOn(service, 'checkFollowStatus').mockResolvedValue(false);
      vi.spyOn(service, 'clickFollowButton').mockResolvedValue({
        status: 'followed',
        selector: 'post:follow-button',
      });

      const promise = service.followProfile('p1', { jwtToken: 'jwt' });
      // Advance timers for any paced delays
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(result.status).toBe('followed');
      expect(result.profileId).toBe('p1');
      expect(mockNavService.navigateToProfile).toHaveBeenCalledWith('p1');
      expect(mockConnService.ensureEdge).toHaveBeenCalledWith('p1', 'followed', 'jwt');
    });

    it('should return already_following when already following', async () => {
      vi.spyOn(service, 'checkFollowStatus').mockResolvedValue(true);

      const result = await service.followProfile('p1');

      expect(result.status).toBe('already_following');
    });

    it('should throw when navigation fails', async () => {
      mockNavService.navigateToProfile.mockResolvedValue(false);

      await expect(service.followProfile('p1')).rejects.toThrow('Failed to navigate to profile');
    });
  });

  describe('checkFollowStatus', () => {
    it('should return true when following indicator found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      const result = await service.checkFollowStatus();
      expect(result).toBe(true);
    });

    it('should return false when no indicator found', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      const result = await service.checkFollowStatus();
      expect(result).toBe(false);
    });
  });

  describe('clickFollowButton', () => {
    it('should click direct follow button when found', async () => {
      const mockElement = {
        getAttribute: vi.fn().mockResolvedValue('Follow Test User'),
        innerText: vi.fn().mockResolvedValue('Follow'),
        click: vi.fn(),
      };
      mockResolver.resolveWithWait.mockResolvedValue(mockElement);

      // checkFollowStatus after click
      vi.spyOn(service, 'checkFollowStatus').mockResolvedValue(true);

      const promise = service.clickFollowButton('p1');
      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result.status).toBe('followed');
    });

    it('should throw when follow button not found', async () => {
      // Use real timers: the error path never reaches _paced(), so fake
      // timers are unnecessary and cause an unhandled-rejection race.
      vi.useRealTimers();
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      mockConnService.isProfileContainer.mockResolvedValue(false);

      await expect(service.clickFollowButton('p1')).rejects.toThrow('Follow button not found');
    });
  });
});
