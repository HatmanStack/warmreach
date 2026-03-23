import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionNavigationService } from './interactionNavigationService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: vi.fn().mockImplementation(function () {
    return { setAuthToken: vi.fn(), upsertEdgeStatus: vi.fn().mockResolvedValue(true) };
  }),
}));

vi.mock('../../session/services/browserSessionManager.js', () => ({
  BrowserSessionManager: {
    getInstance: vi.fn(),
    cleanup: vi.fn(),
    isSessionHealthy: vi.fn(),
    getHealthStatus: vi.fn(),
    getSessionMetrics: vi.fn().mockReturnValue({ recordOperation: vi.fn() }),
    recordError: vi.fn(),
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

describe('InteractionNavigationService', () => {
  let service;
  let mockPage;
  let mockSession;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPage = buildPuppeteerPage();
    mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({ ok: () => true }),
      waitForSelector: vi.fn().mockResolvedValue({}),
    };
    BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

    service = new InteractionNavigationService();
  });

  describe('navigateToProfile', () => {
    it('should navigate to profile URL and verify page', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      mockPage.url.mockReturnValue('https://www.linkedin.com/in/test');
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      const promise = service.navigateToProfile('test-id');
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      const success = await promise;

      expect(success).toBe(true);
      expect(mockSession.goto).toHaveBeenCalledWith(
        expect.stringContaining('test-id'),
        expect.any(Object)
      );
    });

    it('should return false on navigation failure', async () => {
      mockSession.goto.mockRejectedValue(new Error('timeout'));

      const success = await service.navigateToProfile('bad-id');
      expect(success).toBe(false);
    });

    it('should handle full URLs', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      mockPage.url.mockReturnValue('https://www.linkedin.com/in/test');
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      const promise = service.navigateToProfile('https://www.linkedin.com/in/test');
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      await promise;

      expect(mockSession.goto).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/test',
        expect.any(Object)
      );
    });
  });

  describe('verifyProfilePage', () => {
    it('should return true when profile indicator found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      const result = await service.verifyProfilePage(mockPage);
      expect(result).toBe(true);
    });

    it('should use URL fallback when resolver fails', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      mockPage.url.mockReturnValue('https://www.linkedin.com/in/test-user');
      const result = await service.verifyProfilePage(mockPage);
      expect(result).toBe(true);
    });
  });
});
