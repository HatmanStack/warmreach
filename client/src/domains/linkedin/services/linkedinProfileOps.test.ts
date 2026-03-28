import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  navigateToProfile,
  verifyProfilePage,
  initializeBrowserSession,
  getBrowserSession,
  closeBrowserSession,
  isSessionActive,
  getSessionStatus,
  checkSuspiciousActivity,
} from './linkedinProfileOps.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#shared-config/index.js', () => ({
  default: { linkedin: { baseUrl: 'https://www.linkedin.com' } },
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

vi.mock('../../session/services/browserSessionManager.js', () => ({
  BrowserSessionManager: {
    getInstance: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock('../utils/LinkedInError.js', () => ({
  LinkedInError: class extends Error {
    constructor(msg, code, _opts) {
      super(msg);
      this.code = code;
    }
  },
}));

describe('linkedinProfileOps', () => {
  let mockService;
  let mockPage;
  let mockSession;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = {
      url: vi.fn().mockReturnValue('https://www.linkedin.com/in/test'),
      evaluate: vi.fn().mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      }),
    };
    mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({}),
    };
    mockService = {
      sessionManager: {
        getInstance: vi.fn().mockResolvedValue(mockSession),
        isSessionHealthy: vi.fn().mockResolvedValue(true),
        getHealthStatus: vi.fn().mockResolvedValue({ healthy: true }),
        cleanup: vi.fn(),
        recordError: vi.fn(),
      },
      configManager: {
        get: vi.fn((key, def) => def),
      },
      getBrowserSession: vi.fn().mockResolvedValue(mockSession),
      waitForLinkedInLoad: vi.fn().mockResolvedValue(undefined),
      waitForPageStability: vi.fn().mockResolvedValue(true),
      verifyProfilePage: vi.fn().mockResolvedValue(true),
    };
  });

  describe('navigateToProfile', () => {
    it('should navigate to profile and return true on success', async () => {
      const result = await navigateToProfile(mockService, 'test-user');
      expect(mockSession.goto).toHaveBeenCalledWith(
        expect.stringContaining('test-user'),
        expect.any(Object)
      );
      expect(result).toBe(true);
    });

    it('should handle full URLs', async () => {
      await navigateToProfile(mockService, 'https://www.linkedin.com/in/test-user');
      expect(mockSession.goto).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/test-user',
        expect.any(Object)
      );
    });

    it('should return false on navigation error', async () => {
      mockSession.goto.mockRejectedValue(new Error('timeout'));
      const result = await navigateToProfile(mockService, 'test-user');
      expect(result).toBe(false);
    });
  });

  describe('verifyProfilePage', () => {
    it('should return true when resolver finds indicator', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      const result = await verifyProfilePage(mockService, mockPage);
      expect(result).toBe(true);
    });

    it('should fall back to URL check', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      mockPage.url.mockReturnValue('https://www.linkedin.com/in/user');
      const result = await verifyProfilePage(mockService, mockPage);
      expect(result).toBe(true);
    });
  });

  describe('initializeBrowserSession', () => {
    it('should call getInstance with reinitialize flag', async () => {
      await initializeBrowserSession(mockService);
      expect(mockService.sessionManager.getInstance).toHaveBeenCalledWith({
        reinitializeIfUnhealthy: true,
      });
    });
  });

  describe('getBrowserSession', () => {
    it('should call getInstance without reinitialize', async () => {
      await getBrowserSession(mockService);
      expect(mockService.sessionManager.getInstance).toHaveBeenCalledWith({
        reinitializeIfUnhealthy: false,
      });
    });
  });

  describe('closeBrowserSession', () => {
    it('should call cleanup', async () => {
      await closeBrowserSession(mockService);
      expect(mockService.sessionManager.cleanup).toHaveBeenCalled();
    });
  });

  describe('isSessionActive', () => {
    it('should delegate to session manager', async () => {
      const result = await isSessionActive(mockService);
      expect(result).toBe(true);
    });
  });

  describe('getSessionStatus', () => {
    it('should return combined status', async () => {
      const result = await getSessionStatus(mockService);
      expect(result).toHaveProperty('humanBehavior');
      expect(result.humanBehavior.suspiciousActivity.isSuspicious).toBe(false);
    });
  });

  describe('checkSuspiciousActivity', () => {
    it('should return safe default', async () => {
      const result = await checkSuspiciousActivity(mockService);
      expect(result.isSuspicious).toBe(false);
    });
  });
});
