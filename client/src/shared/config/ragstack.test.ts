import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Store original env values
const originalEnv = { ...process.env };

describe('ragstackConfig', () => {
  beforeEach(() => {
    // Reset modules and clear env vars before each test
    vi.resetModules();
    delete process.env.RAGSTACK_GRAPHQL_ENDPOINT;
    delete process.env.RAGSTACK_API_KEY;
  });

  afterEach(() => {
    // Restore original env
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('RAGSTACK_')) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  it('should return isConfigured false when env vars missing', async () => {
    const { ragstackConfig } = await import('./ragstack.js');
    expect(ragstackConfig.isConfigured()).toBe(false);
  });

  it('should return isConfigured true when both endpoint and apiKey are set', async () => {
    process.env.RAGSTACK_GRAPHQL_ENDPOINT = 'https://test.appsync-api.amazonaws.com/graphql';
    process.env.RAGSTACK_API_KEY = 'test-api-key';

    const { ragstackConfig } = await import('./ragstack.js');

    expect(ragstackConfig.isConfigured()).toBe(true);
    expect(ragstackConfig.endpoint).toBe('https://test.appsync-api.amazonaws.com/graphql');
    expect(ragstackConfig.apiKey).toBe('test-api-key');
  });

  it('should return isConfigured false when only endpoint is set', async () => {
    process.env.RAGSTACK_GRAPHQL_ENDPOINT = 'https://test.appsync-api.amazonaws.com/graphql';

    const { ragstackConfig } = await import('./ragstack.js');

    expect(ragstackConfig.isConfigured()).toBe(false);
  });

  it('should return isConfigured false when only apiKey is set', async () => {
    process.env.RAGSTACK_API_KEY = 'test-api-key';

    const { ragstackConfig } = await import('./ragstack.js');

    expect(ragstackConfig.isConfigured()).toBe(false);
  });

  it('should use default retry values', async () => {
    const { ragstackConfig } = await import('./ragstack.js');

    expect(ragstackConfig.retry.maxAttempts).toBe(3);
    expect(ragstackConfig.retry.baseDelay).toBe(1000);
    expect(ragstackConfig.retry.maxDelay).toBe(30000);
  });
});
