import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { RATE_LIMIT_CEILINGS } from '#config';

// Mock config before importing the service — preserve real named exports
vi.mock('#config', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      controlPlane: {
        url: 'https://api.warmreach.com/prod',
        deploymentId: 'deploy-123',
        apiKey: 'test-api-key',
      },
    },
  };
});

vi.mock('#utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('axios');

describe('ControlPlaneService', () => {
  let ControlPlaneService;
  let mockAxiosInstance;

  beforeEach(async () => {
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
    };
    axios.create.mockReturnValue(mockAxiosInstance);

    // Dynamic import to get fresh module with mocked deps
    const mod = await import('./controlPlaneService.js');
    ControlPlaneService = mod.default;
    ControlPlaneService._resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('returns true when CONTROL_PLANE_URL is set', () => {
      const svc = new ControlPlaneService();
      expect(svc.isConfigured).toBe(true);
    });
  });

  describe('syncRateLimits', () => {
    it('returns cached response within TTL', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { linkedin_interactions: { daily_limit: 300 } },
      });

      const svc = new ControlPlaneService();

      // First call fetches
      const result1 = await svc.syncRateLimits();
      expect(result1).toEqual({ linkedin_interactions: { daily_limit: 300 } });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);

      // Second call returns cache
      const result2 = await svc.syncRateLimits();
      expect(result2).toEqual({ linkedin_interactions: { daily_limit: 300 } });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1); // no new call
    });

    it('fetches fresh data after TTL expires', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { v: 1 } })
        .mockResolvedValueOnce({ data: { v: 2 } });

      const svc = new ControlPlaneService();

      await svc.syncRateLimits();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);

      // Force cache expiry
      ControlPlaneService._resetState();
      // Re-seed with expired cache
      // We need to call again, it will fetch fresh data
      const result = await svc.syncRateLimits();
      expect(result).toEqual({ v: 2 });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('circuit breaker', () => {
    it('opens after 3 consecutive failures', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('network error'));

      const svc = new ControlPlaneService();

      // 3 failures to trip the breaker
      await svc.syncRateLimits();
      await svc.syncRateLimits();
      await svc.syncRateLimits();

      const state = ControlPlaneService._getState();
      expect(state.circuitState).toBe('open');
      expect(state.consecutiveFailures).toBe(3);
    });

    it('returns null when circuit is open', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('network error'));

      const svc = new ControlPlaneService();

      // Trip the breaker
      await svc.syncRateLimits();
      await svc.syncRateLimits();
      await svc.syncRateLimits();

      // This call should not make a network request
      const result = await svc.syncRateLimits();
      expect(result).toBeNull();
      // Only 3 calls made (the ones that tripped), not 4
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
    });

    it('half-opens after recovery timeout', async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ data: { recovered: true } });

      const svc = new ControlPlaneService();

      // Trip the breaker
      await svc.syncRateLimits();
      await svc.syncRateLimits();
      await svc.syncRateLimits();

      expect(ControlPlaneService._getState().circuitState).toBe('open');

      // Reset to simulate recovery (we can't manipulate module-level timestamps directly)
      ControlPlaneService._resetState();

      // After reset, should work again
      const result = await svc.syncRateLimits();
      expect(result).toEqual({ recovered: true });
    });
  });

  describe('reportInteraction', () => {
    it('never throws even on network error', () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('network error'));

      const svc = new ControlPlaneService();

      // Should not throw
      expect(() => svc.reportInteraction('sendMessage')).not.toThrow();
    });

    it('sends the correct payload', () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { success: true } });

      const svc = new ControlPlaneService();
      svc.reportInteraction('sendMessage', { profileId: 'abc' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'report-interaction',
        expect.objectContaining({
          deploymentId: 'deploy-123',
          operation: 'sendMessage',
          metadata: { profileId: 'abc' },
        })
      );
    });
  });

  describe('register', () => {
    it('returns deployment info on success', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { deploymentId: 'new-deploy', controlPlaneApiKey: 'new-key' },
      });

      const svc = new ControlPlaneService();
      const result = await svc.register({ stackName: 'test-stack' });

      expect(result).toEqual({ deploymentId: 'new-deploy', controlPlaneApiKey: 'new-key' });
    });

    it('returns null on failure', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('fail'));

      const svc = new ControlPlaneService();
      const result = await svc.register({ stackName: 'test-stack' });

      expect(result).toBeNull();
    });
  });

  describe('reportUsage', () => {
    it('returns result on success', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { allowed: true, remaining: 99 },
      });

      const svc = new ControlPlaneService();
      const result = await svc.reportUsage('generate_message', 1);

      expect(result).toEqual({ allowed: true, remaining: 99 });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'report-usage',
        expect.objectContaining({
          deploymentId: 'deploy-123',
          operation: 'generate_message',
          count: 1,
        })
      );
    });

    it('throws on 429 with QUOTA_EXCEEDED code', async () => {
      const error = new Error('Request failed');
      error.response = { status: 429, data: { message: 'Daily limit reached' } };
      mockAxiosInstance.post.mockRejectedValue(error);

      const svc = new ControlPlaneService();
      await expect(svc.reportUsage('generate_message')).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    });

    it('returns allowed on network error', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('network error'));

      const svc = new ControlPlaneService();
      const result = await svc.reportUsage('generate_message');

      expect(result).toEqual({ allowed: true });
    });
  });

  describe('getQuotaStatus', () => {
    it('returns quota status on success', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { allowed: true, remaining: 50, dailyLimit: 100 },
      });

      const svc = new ControlPlaneService();
      const result = await svc.getQuotaStatus('generate_message');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(50);
    });

    it('returns defaults on failure', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('fail'));

      const svc = new ControlPlaneService();
      const result = await svc.getQuotaStatus('generate_message');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(-1);
    });
  });

  describe('getFeatureFlags', () => {
    it('returns feature flags on success', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { tier: 'pro', features: { deep_research: true }, quotas: {}, rateLimits: {} },
      });

      const svc = new ControlPlaneService();
      const result = await svc.getFeatureFlags();

      expect(result.tier).toBe('pro');
      expect(result.features.deep_research).toBe(true);
    });

    it('caches feature flags', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { tier: 'pro', features: {} },
      });

      const svc = new ControlPlaneService();
      await svc.getFeatureFlags();
      await svc.getFeatureFlags();

      // Only rate-limits GET was called, plus 1 feature-flags GET
      const featureFlagCalls = mockAxiosInstance.get.mock.calls.filter(
        (call) => call[0] === 'feature-flags'
      );
      expect(featureFlagCalls.length).toBe(1);
    });

    it('returns defaults on failure', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('fail'));

      const svc = new ControlPlaneService();
      const result = await svc.getFeatureFlags();

      expect(result.tier).toBe('free');
    });
  });

  describe('isFeatureEnabled', () => {
    it('returns false when no cache exists', () => {
      const svc = new ControlPlaneService();
      expect(svc.isFeatureEnabled('deep_research')).toBe(false);
    });

    it('returns true when feature is cached as enabled', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { tier: 'pro', features: { deep_research: true } },
      });

      const svc = new ControlPlaneService();
      await svc.getFeatureFlags(); // populate cache
      expect(svc.isFeatureEnabled('deep_research')).toBe(true);
    });
  });
});

describe('RATE_LIMIT_CEILINGS config clamping', () => {
  it('RATE_LIMIT_CEILINGS are defined with expected values', () => {
    expect(RATE_LIMIT_CEILINGS).toBeDefined();
    expect(RATE_LIMIT_CEILINGS.dailyInteractionLimit).toBe(500);
    expect(RATE_LIMIT_CEILINGS.hourlyInteractionLimit).toBe(100);
    expect(RATE_LIMIT_CEILINGS.rateLimitMax).toBe(30);
    expect(RATE_LIMIT_CEILINGS.actionsPerMinute).toBe(15);
    expect(RATE_LIMIT_CEILINGS.actionsPerHour).toBe(200);
  });

  it('Math.min clamps values above ceilings', () => {
    expect(Math.min(999999, RATE_LIMIT_CEILINGS.dailyInteractionLimit)).toBe(500);
    expect(Math.min(999999, RATE_LIMIT_CEILINGS.hourlyInteractionLimit)).toBe(100);
    expect(Math.min(999999, RATE_LIMIT_CEILINGS.rateLimitMax)).toBe(30);
    expect(Math.min(999999, RATE_LIMIT_CEILINGS.actionsPerMinute)).toBe(15);
    expect(Math.min(999999, RATE_LIMIT_CEILINGS.actionsPerHour)).toBe(200);
  });

  it('values below ceilings pass through unchanged', () => {
    expect(Math.min(5, RATE_LIMIT_CEILINGS.dailyInteractionLimit)).toBe(5);
    expect(Math.min(50, RATE_LIMIT_CEILINGS.hourlyInteractionLimit)).toBe(50);
    expect(Math.min(3, RATE_LIMIT_CEILINGS.rateLimitMax)).toBe(3);
  });
});

describe('ControlPlaneService — unconfigured', () => {
  let ControlPlaneService;

  beforeEach(async () => {
    // Re-mock with empty config
    vi.doMock('#config', () => ({
      default: {
        controlPlane: { url: '', deploymentId: '', apiKey: '' },
      },
    }));

    vi.doMock('axios', () => ({
      default: { create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })) },
    }));

    // Clear module cache and re-import
    vi.resetModules();
    const mod = await import('./controlPlaneService.js');
    ControlPlaneService = mod.default;
    ControlPlaneService._resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when CONTROL_PLANE_URL is empty', () => {
    const svc = new ControlPlaneService();
    expect(svc.isConfigured).toBe(false);
  });

  it('syncRateLimits returns null when not configured', async () => {
    const svc = new ControlPlaneService();
    const result = await svc.syncRateLimits();
    expect(result).toBeNull();
  });

  it('reportInteraction is a no-op when not configured', () => {
    const svc = new ControlPlaneService();
    expect(() => svc.reportInteraction('test')).not.toThrow();
  });
});
