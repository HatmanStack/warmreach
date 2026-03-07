import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserSessionManager } from './browserSessionManager.js';
import { PuppeteerService } from '../../automation/services/puppeteerService.js';

// Mock dependencies
vi.mock('../../automation/services/puppeteerService.js', () => {
  return {
    PuppeteerService: vi.fn().mockImplementation(function () {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getBrowser: vi.fn().mockReturnValue({
          isConnected: vi.fn().mockReturnValue(true),
        }),
        getPage: vi.fn().mockReturnValue({
          isClosed: vi.fn().mockReturnValue(false),
          evaluate: vi.fn().mockResolvedValue('complete'),
          url: vi.fn().mockReturnValue('https://linkedin.com'),
        }),
      };
    }),
  };
});

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#shared-config/configManager.js', () => ({
  default: {
    getSessionConfig: vi.fn().mockReturnValue({ maxErrors: 3, timeout: 3600000 }),
  },
}));

vi.mock('../../automation/utils/signalDetector.js', () => {
  return {
    SignalDetector: vi.fn().mockImplementation(function () {
      return {
        clear: vi.fn(),
      };
    }),
  };
});

vi.mock('../../automation/utils/sessionMetrics.js', () => {
  return {
    SessionMetrics: vi.fn().mockImplementation(function () {
      return {
        reset: vi.fn(),
      };
    }),
  };
});

vi.mock('../../automation/utils/contentSignalAnalyzer.js', () => ({
  getContentAnalyzer: vi.fn().mockReturnValue({}),
  _resetContentAnalyzerForTesting: vi.fn(),
}));

vi.mock('../../automation/utils/backoffController.js', () => {
  return {
    BackoffController: vi.fn().mockImplementation(function () {
      return {
        start: vi.fn(),
        stop: vi.fn(),
      };
    }),
  };
});

vi.mock('../../automation/utils/interactionQueue.js', () => ({
  linkedInInteractionQueue: {},
}));

vi.mock('../../linkedin/selectors/index.js', () => ({
  linkedinResolver: {},
}));

describe('BrowserSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    BrowserSessionManager._resetForTesting();
  });

  describe('getInstance', () => {
    it('should create a new session if none exists', async () => {
      const instance = await BrowserSessionManager.getInstance();
      expect(instance).toBeDefined();
      expect(PuppeteerService).toHaveBeenCalled();
      expect(instance.initialize).toHaveBeenCalled();
    });

    it('should reuse existing healthy session', async () => {
      const first = await BrowserSessionManager.getInstance();
      const second = await BrowserSessionManager.getInstance();
      expect(first).toBe(second);
      expect(PuppeteerService).toHaveBeenCalledTimes(1);
    });

    it('should reinitialize if session is unhealthy', async () => {
      const first = await BrowserSessionManager.getInstance();

      // Make session unhealthy
      first.getBrowser().isConnected.mockReturnValue(false);

      const second = await BrowserSessionManager.getInstance({ reinitializeIfUnhealthy: true });
      expect(first).not.toBe(second);
      expect(PuppeteerService).toHaveBeenCalledTimes(2);
    });
  });

  describe('isSessionHealthy', () => {
    it('should return false if no instance exists', async () => {
      expect(await BrowserSessionManager.isSessionHealthy()).toBe(false);
    });

    it('should return true if session is active and responsive', async () => {
      await BrowserSessionManager.getInstance();
      expect(await BrowserSessionManager.isSessionHealthy()).toBe(true);
    });

    it('should return false if page is closed', async () => {
      const instance = await BrowserSessionManager.getInstance();
      instance.getPage().isClosed.mockReturnValue(true);
      expect(await BrowserSessionManager.isSessionHealthy()).toBe(false);
    });
  });

  describe('recordError', () => {
    it('should increment error count', async () => {
      await BrowserSessionManager.recordError(new Error('test'));
      expect(BrowserSessionManager.errorCount).toBe(1);
    });

    it('should attempt recovery when max errors reached', async () => {
      await BrowserSessionManager.getInstance();

      await BrowserSessionManager.recordError(new Error('1'));
      await BrowserSessionManager.recordError(new Error('2'));

      // Mock maxErrors = 3
      const recovered = await BrowserSessionManager.recordError(new Error('3'));

      expect(recovered).toBe(true);
      expect(PuppeteerService).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup', () => {
    it('should close instance and reset state', async () => {
      const instance = await BrowserSessionManager.getInstance();
      await BrowserSessionManager.cleanup();

      expect(instance.close).toHaveBeenCalled();
      expect(BrowserSessionManager.instance).toBeNull();
    });
  });
});
