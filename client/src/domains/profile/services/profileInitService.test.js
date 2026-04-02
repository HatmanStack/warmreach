/**
 * Tests for ProfileInitService RAGStack ingestion functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../shared/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock profileInitMonitor
vi.mock('../utils/profileInitMonitor.js', () => ({
  profileInitMonitor: {
    recordConnection: vi.fn(),
    getStats: vi.fn(),
  },
}));

// Mock ProfileInitStateManager
vi.mock('../utils/profileInitStateManager.js', () => ({
  ProfileInitStateManager: {
    validateState: vi.fn(),
    isResumingState: vi.fn().mockReturnValue(false),
    getProgressSummary: vi.fn().mockReturnValue({}),
    updateBatchProgress: vi.fn((state) => state),
    createListCreationHealingState: vi.fn(),
  },
}));

// Mock randomHelpers
vi.mock('../../shared/utils/randomHelpers.js', () => ({
  default: {
    randomDelay: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock linkedinErrorHandler
vi.mock('../utils/linkedinErrorHandler.js', () => ({
  default: {
    categorizeError: vi.fn().mockReturnValue({
      type: 'unknown',
      category: 'unknown',
      isRecoverable: false,
    }),
  },
}));

// Mock profile markdown generator
vi.mock('../utils/profileMarkdownGenerator.js', () => ({
  generateProfileMarkdown: vi.fn().mockReturnValue('# Test Profile\n\nTest content'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Now import after all mocks are set up
import { ProfileInitService } from './profileInitService.js';

describe('ProfileInitService', () => {
  let service;
  let mockPuppeteerService;
  let mockLinkedInService;
  let mockLinkedInContactService;
  let mockDynamoDBService;
  let savedUrl;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    savedUrl = process.env.API_GATEWAY_BASE_URL;

    // Setup mocks
    mockPuppeteerService = {};
    mockLinkedInService = {
      login: vi.fn().mockResolvedValue({}),
      getConnections: vi.fn().mockResolvedValue([]),
    };
    mockLinkedInContactService = {
      scrapeProfile: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Scraped', profileId: 'test' }),
    };
    mockDynamoDBService = {
      setAuthToken: vi.fn(),
      checkEdgeExists: vi.fn().mockResolvedValue(false),
      upsertEdgeStatus: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    if (savedUrl !== undefined) {
      process.env.API_GATEWAY_BASE_URL = savedUrl;
    } else {
      delete process.env.API_GATEWAY_BASE_URL;
    }
  });

  function createService() {
    return new ProfileInitService(
      mockPuppeteerService,
      mockLinkedInService,
      mockLinkedInContactService,
      mockDynamoDBService
    );
  }

  describe('triggerRAGStackIngestion', () => {
    const mockState = {
      requestId: 'test-request-123',
      jwtToken: 'test-jwt-token',
    };

    it('should skip ingestion when API_GATEWAY_BASE_URL is not configured', async () => {
      delete process.env.API_GATEWAY_BASE_URL;
      service = createService();

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip ingestion when profile is not found in DynamoDB', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
      service = createService();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profile: null }),
      });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('profiles'),
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should skip ingestion when profile is already ingested', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
      service = createService();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            profile: {
              name: 'John Doe',
              ragstack_ingested: true,
            },
          }),
      });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      // Only the GET fetch, no POST
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should skip ingestion when profile is missing required name field', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
      service = createService();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            profile: {
              headline: 'Software Engineer',
              // name is missing
            },
          }),
      });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should successfully trigger ingestion for valid profile', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
      service = createService();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              profile: {
                name: 'John Doe',
                headline: 'Software Engineer',
                location: 'San Francisco, CA',
                currentTitle: 'Senior Engineer',
                currentCompany: 'Tech Corp',
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              documentId: 'doc-123',
              status: 'uploaded',
            }),
        });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toEqual({
        documentId: 'doc-123',
        status: 'uploaded',
      });

      // Second call is the POST for ingestion
      const postCall = mockFetch.mock.calls[1];
      expect(postCall[0]).toContain('ragstack');
      const postBody = JSON.parse(postCall[1].body);
      expect(postBody.operation).toBe('ingest');
      expect(postBody.profileId).toBe('profile123');
      expect(postCall[1].headers.Authorization).toBe('Bearer test-jwt-token');
    });

    it('should handle ingestion errors gracefully without throwing', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
      service = createService();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              profile: {
                name: 'John Doe',
              },
            }),
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      // ingest() catches errors and returns { success: false }
      expect(result).toEqual({ success: false });
    });

    it('should include JWT token in authorization header', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
      service = createService();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              profile: {
                name: 'John Doe',
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ documentId: 'doc-123' }),
        });

      await service.triggerRAGStackIngestion('profile123', mockState);

      // GET call should have auth header
      const getCall = mockFetch.mock.calls[0];
      expect(getCall[1].headers.Authorization).toBe('Bearer test-jwt-token');
    });

    it('should normalize API base URL with trailing slash', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod'; // No trailing slash
      service = createService();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              profile: {
                name: 'John Doe',
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ documentId: 'doc-123' }),
        });

      await service.triggerRAGStackIngestion('profile123', mockState);

      const getCall = mockFetch.mock.calls[0];
      expect(getCall[0]).toBe('https://api.example.com/prod/profiles?profileId=profile123');
    });
  });
});
