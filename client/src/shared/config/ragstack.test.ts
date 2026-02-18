import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Store original env values
const originalEnv = { ...process.env };

describe('ragstackConfig', () => {
  beforeEach(() => {
    // Reset modules and clear env vars before each test
    vi.resetModules();
    delete process.env.RAGSTACK_GRAPHQL_ENDPOINT;
    delete process.env.RAGSTACK_API_KEY;
    delete process.env.RAGSTACK_SCRAPE_MAX_PAGES;
    delete process.env.RAGSTACK_SCRAPE_MAX_DEPTH;
    delete process.env.RAGSTACK_SCRAPE_MODE;
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

  it('should parse numeric config from env vars', async () => {
    process.env.RAGSTACK_GRAPHQL_ENDPOINT = 'https://test.appsync-api.amazonaws.com/graphql';
    process.env.RAGSTACK_API_KEY = 'test-api-key';
    process.env.RAGSTACK_SCRAPE_MAX_PAGES = '10';
    process.env.RAGSTACK_SCRAPE_MAX_DEPTH = '2';

    const { ragstackConfig } = await import('./ragstack.js');

    expect(ragstackConfig.scrape.maxPages).toBe(10);
    expect(ragstackConfig.scrape.maxDepth).toBe(2);
    expect(typeof ragstackConfig.scrape.maxPages).toBe('number');
    expect(typeof ragstackConfig.scrape.maxDepth).toBe('number');
  });

  it('should use default values when env vars not set', async () => {
    const { ragstackConfig } = await import('./ragstack.js');

    // Default scrape settings
    expect(ragstackConfig.scrape.maxPages).toBe(5);
    expect(ragstackConfig.scrape.maxDepth).toBe(1);
    expect(ragstackConfig.scrape.scrapeMode).toBe('FULL');
    expect(ragstackConfig.scrape.scope).toBe('SUBPAGES');

    // Default retry settings
    expect(ragstackConfig.retry.maxAttempts).toBe(3);
    expect(ragstackConfig.retry.baseDelay).toBe(1000);
    expect(ragstackConfig.retry.maxDelay).toBe(30000);
  });

  it('should parse scrapeMode from env var', async () => {
    process.env.RAGSTACK_GRAPHQL_ENDPOINT = 'https://test.appsync-api.amazonaws.com/graphql';
    process.env.RAGSTACK_API_KEY = 'test-api-key';
    process.env.RAGSTACK_SCRAPE_MODE = 'FAST';

    const { ragstackConfig } = await import('./ragstack.js');

    expect(ragstackConfig.scrape.scrapeMode).toBe('FAST');
  });
});
