import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInNavigationService } from './linkedinNavigationService.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock config
vi.mock('#shared-config/index.js', () => ({
  config: {
    linkedin: {
      baseUrl: 'https://www.linkedin.com',
    },
  },
}));

// Mock linkedinResolver and linkedinSelectors
const { mockResolver, mockSelectors } = vi.hoisted(() => ({
  mockResolver: {
    resolve: vi.fn(),
    resolveWithWait: vi.fn(),
  },
  mockSelectors: {
    'nav:main-content': [{ selector: '.main' }],
    'nav:page-loaded': [{ selector: '.loaded' }],
    'nav:homepage': [{ selector: '.home' }],
  },
}));

vi.mock('../../linkedin/selectors/index.js', () => ({
  linkedinResolver: mockResolver,
  linkedinSelectors: mockSelectors,
}));

describe('LinkedInNavigationService', () => {
  let service;
  let mockSessionManager;
  let mockConfigManager;
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
    mockSessionManager = {
      getInstance: vi.fn().mockResolvedValue(mockSession),
      recordError: vi.fn().mockResolvedValue(undefined),
      getBackoffController: vi.fn().mockReturnValue(null),
    };
    mockConfigManager = {
      get: vi.fn((key, def) => def),
    };

    service = new LinkedInNavigationService({
      sessionManager: mockSessionManager,
      configManager: mockConfigManager,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should throw error if sessionManager is missing', () => {
      expect(() => new LinkedInNavigationService({ configManager: mockConfigManager })).toThrow();
    });

    it('should throw error if configManager is missing', () => {
      expect(() => new LinkedInNavigationService({ sessionManager: mockSessionManager })).toThrow();
    });
  });

  describe('navigateToProfile', () => {
    it('should navigate to profile URL and verify page', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({ id: 'indicator' });

      // Mock metrics for stabilization
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      const promise = service.navigateToProfile('john-doe');

      // Advance timers to trigger stability samples
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }

      const result = await promise;

      expect(result).toBe(true);
      expect(mockSession.goto).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/john-doe/',
        expect.any(Object)
      );
      expect(mockResolver.resolveWithWait).toHaveBeenCalledWith(
        mockPage,
        'nav:profile-indicator',
        expect.any(Object)
      );
    });

    it('should handle full profile URL', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({ id: 'indicator' });
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      const promise = service.navigateToProfile('https://www.linkedin.com/in/jane-smith');
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = await promise;

      expect(result).toBe(true);
      expect(mockSession.goto).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/jane-smith',
        expect.any(Object)
      );
    });

    it('should return false if verification fails', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('Not found'));
      mockPage.url.mockReturnValue('https://www.linkedin.com/feed/'); // Not a profile URL
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      const promise = service.navigateToProfile('john-doe');
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = await promise;

      expect(result).toBe(false);
      expect(mockSessionManager.recordError).toHaveBeenCalled();
    });
  });

  describe('verifyProfilePage', () => {
    it('should return true if profile indicator found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      const result = await service.verifyProfilePage(mockPage);
      expect(result).toBe(true);
    });

    it('should return true if URL contains /in/', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error());
      mockPage.url.mockReturnValue('https://www.linkedin.com/in/test');
      const result = await service.verifyProfilePage(mockPage);
      expect(result).toBe(true);
    });

    it('should return false if both checks fail', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error());
      mockPage.url.mockReturnValue('https://www.linkedin.com/feed/');
      const result = await service.verifyProfilePage(mockPage);
      expect(result).toBe(false);
    });
  });

  describe('waitForLinkedInLoad', () => {
    it('should finish when page is stable', async () => {
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      // It samples every 250ms and needs 3 stable samples
      const promise = service.waitForLinkedInLoad();

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }

      await promise;
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('should detect checkpoint and call backoff controller', async () => {
      const mockController = { handleCheckpoint: vi.fn() };
      mockSessionManager.getBackoffController.mockReturnValue(mockController);

      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        isCheckpoint: true,
        url: 'https://www.linkedin.com/checkpoint/challenge',
      });

      // We only need one sample to detect checkpoint
      // But it will keep running until timeout unless it stabilizes
      let callCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ready: 'complete',
          main: true,
          anchors: 10,
          images: 5,
          height: 1000,
          isCheckpoint: callCount === 1,
          url: 'https://www.linkedin.com/checkpoint/challenge',
        });
      });

      const promise = service.waitForLinkedInLoad();
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      await promise;
      expect(mockController.handleCheckpoint).toHaveBeenCalled();
    });
  });

  describe('findElementBySelectors', () => {
    it('should return first found element', async () => {
      mockSession.waitForSelector.mockImplementation((sel) => {
        if (sel === '.second') return Promise.resolve({ id: 'el' });
        return Promise.reject(new Error());
      });

      const result = await service.findElementBySelectors(['.first', '.second', '.third']);
      expect(result.selector).toBe('.second');
      expect(result.element).toBeDefined();
    });

    it('should return nulls if none found', async () => {
      mockSession.waitForSelector.mockRejectedValue(new Error());
      const result = await service.findElementBySelectors(['.none']);
      expect(result.element).toBeNull();
    });
  });
});
