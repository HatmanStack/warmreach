import { vi } from 'vitest';
import { buildPuppeteerPage } from './factories.js';

/**
 * Shared mock for axios.
 */
export function mockAxios() {
  const mockPost = vi.fn();
  const mockGet = vi.fn();

  vi.mock('axios', () => ({
    default: {
      post: mockPost,
      get: mockGet,
      create: vi.fn(() => ({
        post: mockPost,
        get: mockGet,
        interceptors: {
          request: { use: vi.fn() },
          response: { use: vi.fn() },
        },
      })),
    },
  }));

  return { mockPost, mockGet };
}

/**
 * Shared mock for Puppeteer page.
 */
export function mockPuppeteerPage(overrides = {}) {
  return buildPuppeteerPage(overrides);
}

/**
 * Shared mock for DynamoDB service.
 */
export function mockDynamoDBService() {
  const mockPut = vi.fn().mockResolvedValue(true);
  const mockGet = vi.fn().mockResolvedValue({ Item: {} });
  const mockQuery = vi.fn().mockResolvedValue({ Items: [] });

  vi.mock('../domains/storage/services/dynamoDBService.js', () => ({
    dynamoDBService: {
      put: mockPut,
      get: mockGet,
      query: mockQuery,
      delete: vi.fn().mockResolvedValue(true),
    },
  }));

  return { mockPut, mockGet, mockQuery };
}

/**
 * Shared mock for WebSocket client.
 */
export function mockWebSocketClient() {
  const mockSend = vi.fn();
  const mockOn = vi.fn();

  vi.mock('../transport/wsClient.js', () => ({
    wsClient: {
      send: mockSend,
      on: mockOn,
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
  }));

  return { mockSend, mockOn };
}
