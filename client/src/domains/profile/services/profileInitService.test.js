/**
 * Tests for ProfileInitService RAGStack ingestion functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios first
vi.mock('axios');

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

// Now import after all mocks are set up
import { ProfileInitService } from './profileInitService.js';
import axios from 'axios';

describe('ProfileInitService', () => {
  let service;
  let mockPuppeteerService;
  let mockLinkedInService;
  let mockLinkedInContactService;
  let mockDynamoDBService;

  beforeEach(() => {
    vi.clearAllMocks();

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

    service = new ProfileInitService(
      mockPuppeteerService,
      mockLinkedInService,
      mockLinkedInContactService,
      mockDynamoDBService
    );
  });

  describe('triggerRAGStackIngestion', () => {
    const mockState = {
      requestId: 'test-request-123',
      jwtToken: 'test-jwt-token',
    };

    it('should skip ingestion when API_GATEWAY_BASE_URL is not configured', async () => {
      // Explicitly remove API_BASE_URL to ensure it's undefined
      const oldUrl = process.env.API_GATEWAY_BASE_URL;
      delete process.env.API_GATEWAY_BASE_URL;

      try {
        const result = await service.triggerRAGStackIngestion('profile123', mockState);

        expect(result).toBeNull();
        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
      } finally {
        // Restore if it was set (good practice)
        if (oldUrl) process.env.API_GATEWAY_BASE_URL = oldUrl;
      }
    });

    it('should skip ingestion when profile is not found in DynamoDB', async () => {
      // Setup API_BASE_URL
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';

      axios.get.mockResolvedValue({ data: { profile: null } });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.example.com/prod/profiles',
        expect.objectContaining({
          params: { profileId: 'profile123' },
        })
      );
    });

    it('should skip ingestion when profile is already ingested', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';

      axios.get.mockResolvedValue({
        data: {
          profile: {
            name: 'John Doe',
            ragstack_ingested: true,
          },
        },
      });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should skip ingestion when profile is missing required name field', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';

      axios.get.mockResolvedValue({
        data: {
          profile: {
            headline: 'Software Engineer',
            // name is missing
          },
        },
      });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should successfully trigger ingestion for valid profile', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';

      axios.get.mockResolvedValue({
        data: {
          profile: {
            name: 'John Doe',
            headline: 'Software Engineer',
            location: 'San Francisco, CA',
            currentTitle: 'Senior Engineer',
            currentCompany: 'Tech Corp',
          },
        },
      });

      axios.post.mockResolvedValue({
        data: {
          documentId: 'doc-123',
          status: 'uploaded',
        },
      });

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toEqual({
        documentId: 'doc-123',
        status: 'uploaded',
      });

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.example.com/prod/ragstack',
        expect.objectContaining({
          operation: 'ingest',
          profileId: 'profile123',
          markdownContent: expect.any(String),
          metadata: expect.objectContaining({
            source: 'profile_init',
          }),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
          }),
        })
      );
    });

    it('should handle ingestion errors gracefully without throwing', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';

      axios.get.mockResolvedValue({
        data: {
          profile: {
            name: 'John Doe',
          },
        },
      });

      axios.post.mockRejectedValue(new Error('Network error'));

      const result = await service.triggerRAGStackIngestion('profile123', mockState);

      expect(result).toBeNull();
      // Should not throw
    });

    it('should include JWT token in authorization header', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';

      axios.get.mockResolvedValue({
        data: {
          profile: {
            name: 'John Doe',
          },
        },
      });

      axios.post.mockResolvedValue({
        data: { documentId: 'doc-123' },
      });

      await service.triggerRAGStackIngestion('profile123', mockState);

      expect(axios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
          }),
        })
      );
    });

    it('should normalize API base URL with trailing slash', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod'; // No trailing slash

      axios.get.mockResolvedValue({
        data: {
          profile: {
            name: 'John Doe',
          },
        },
      });

      axios.post.mockResolvedValue({
        data: { documentId: 'doc-123' },
      });

      await service.triggerRAGStackIngestion('profile123', mockState);

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.example.com/prod/profiles',
        expect.any(Object)
      );
    });
  });

  describe('_fetchProfileForIngestion', () => {
    const mockState = {
      jwtToken: 'test-jwt-token',
    };

    beforeEach(() => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
    });

    it('should return profile data on successful fetch', async () => {
      const mockProfile = {
        name: 'Jane Doe',
        headline: 'Product Manager',
      };

      axios.get.mockResolvedValue({
        data: { profile: mockProfile },
      });

      const result = await service._fetchProfileForIngestion('profile456', mockState);

      expect(result).toEqual({ profile: mockProfile });
    });

    it('should return null on fetch error', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));

      const result = await service._fetchProfileForIngestion('profile456', mockState);

      expect(result).toBeNull();
    });
  });

  describe('_callRAGStackProxy', () => {
    const mockState = {
      jwtToken: 'test-jwt-token',
    };

    beforeEach(() => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/prod';
    });

    it('should call RAGStack proxy with correct payload', async () => {
      const mockPayload = {
        operation: 'ingest',
        profileId: 'profile789',
        markdown: '# Test',
      };

      axios.post.mockResolvedValue({
        data: { success: true },
      });

      const result = await service._callRAGStackProxy(mockPayload, mockState);

      expect(result).toEqual({ success: true });
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.example.com/prod/ragstack',
        mockPayload,
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-jwt-token',
          },
        })
      );
    });
  });
});
