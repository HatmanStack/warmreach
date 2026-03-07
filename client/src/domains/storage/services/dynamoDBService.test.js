import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

// Mock dependencies
vi.mock('axios', () => {
  return {
    default: {
      create: vi.fn().mockReturnValue({
        post: vi.fn(),
        get: vi.fn(),
        interceptors: {
          request: { use: vi.fn() },
          response: { use: vi.fn() },
        },
      }),
    },
  };
});

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('DynamoDBService', () => {
  let service;
  let mockAxiosInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('API_GATEWAY_BASE_URL', 'https://api.example.com/');

    // Reset modules to ensure environment variable is picked up if it's top-level
    vi.resetModules();
    const { default: DynamoDBService } = await import('./dynamoDBService.js');

    service = new DynamoDBService();
    mockAxiosInstance = service.apiClient;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('constructor', () => {
    it('should initialize axios with base URL', () => {
      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.example.com/',
        })
      );
    });
  });

  describe('setAuthToken', () => {
    it('should set auth token and include it in headers', async () => {
      service.setAuthToken('test-token');
      expect(service.authToken).toBe('test-token');

      mockAxiosInstance.get.mockResolvedValue({ data: {} });
      await service.getProfileDetails('test-id');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });
  });

  describe('getProfileDetails', () => {
    it('should return true if profile is stale', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40); // 40 days ago

      mockAxiosInstance.get.mockResolvedValue({
        data: {
          profile: {
            updatedAt: oldDate.toISOString(),
          },
        },
      });

      const isStale = await service.getProfileDetails('test-id');
      expect(isStale).toBe(true);
    });

    it('should return false if profile is fresh', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5); // 5 days ago

      mockAxiosInstance.get.mockResolvedValue({
        data: {
          profile: {
            updatedAt: recentDate.toISOString(),
          },
        },
      });

      const isStale = await service.getProfileDetails('test-id');
      expect(isStale).toBe(false);
    });

    it('should return true if profile does not exist', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: {} });
      const isStale = await service.getProfileDetails('test-id');
      expect(isStale).toBe(true);
    });
  });

  describe('markBadContact', () => {
    it('should call create operation with evaluated: true', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { success: true } });

      await service.markBadContact('bad-id');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'dynamodb',
        expect.objectContaining({
          operation: 'create',
          profileId: 'bad-id',
          updates: expect.objectContaining({
            evaluated: true,
          }),
        }),
        expect.any(Object)
      );
    });

    it('should throw error if profileId is missing', async () => {
      await expect(service.markBadContact(null)).rejects.toThrow('profileId is required');
    });
  });

  describe('upsertEdgeStatus', () => {
    it('should call upsert_status operation', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { success: true } });

      await service.upsertEdgeStatus('profile-123', 'connected');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'edges',
        expect.objectContaining({
          operation: 'upsert_status',
          profileId: 'profile-123',
          updates: expect.objectContaining({
            status: 'connected',
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('handleError', () => {
    it('should handle 401 error', () => {
      const error = { response: { status: 401 } };
      const handled = service.handleError(error);
      expect(handled.message).toContain('Authentication required');
    });

    it('should handle network error', () => {
      const error = { request: {} };
      const handled = service.handleError(error);
      expect(handled.message).toContain('Network error');
    });
  });
});
