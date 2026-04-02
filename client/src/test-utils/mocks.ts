import { vi } from 'vitest';
import { buildPuppeteerPage } from './factories.js';

/**
 * Shared mock for fetch.
 */
export function mockFetchClient() {
  const mockFn = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })
  );

  vi.stubGlobal('fetch', mockFn);

  return mockFn;
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
  const mockSetAuthToken = vi.fn();
  const mockGetProfileDetails = vi.fn().mockResolvedValue(true);
  const mockUpsertEdgeStatus = vi.fn().mockResolvedValue({ success: true });
  const mockCheckEdgeExists = vi.fn().mockResolvedValue(false);
  const mockUpdateMessages = vi.fn().mockResolvedValue({ success: true });
  const mockMarkBadContact = vi.fn().mockResolvedValue(true);
  const mockCreateProfileMetadata = vi.fn().mockResolvedValue({});

  vi.mock('../domains/storage/services/dynamoDBService.js', () => ({
    default: vi.fn().mockImplementation(() => ({
      setAuthToken: mockSetAuthToken,
      getProfileDetails: mockGetProfileDetails,
      upsertEdgeStatus: mockUpsertEdgeStatus,
      checkEdgeExists: mockCheckEdgeExists,
      updateMessages: mockUpdateMessages,
      markBadContact: mockMarkBadContact,
      createProfileMetadata: mockCreateProfileMetadata,
      canScrapeToday: vi.fn().mockResolvedValue(true),
      incrementDailyScrapeCount: vi.fn().mockResolvedValue({ count: 1 }),
      saveImportCheckpoint: vi.fn().mockResolvedValue({}),
      getImportCheckpoint: vi.fn().mockResolvedValue(null),
      clearImportCheckpoint: vi.fn().mockResolvedValue({}),
      getHeaders: vi.fn().mockReturnValue({ 'Content-Type': 'application/json' }),
    })),
  }));

  return {
    mockSetAuthToken,
    mockGetProfileDetails,
    mockUpsertEdgeStatus,
    mockCheckEdgeExists,
    mockUpdateMessages,
    mockMarkBadContact,
    mockCreateProfileMetadata,
  };
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
