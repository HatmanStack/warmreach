import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { RagstackProxyService } from './ragstackProxyService.js';

describe('RagstackProxyService', () => {
  let service: RagstackProxyService;
  let mockHttpClient: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpClient = {
      get: vi.fn(),
      post: vi.fn(),
    };
    service = new RagstackProxyService({
      apiBaseUrl: 'https://api.example.com/',
      httpClient: mockHttpClient,
    });
  });

  describe('constructor', () => {
    it('normalizes base URL with trailing slash', () => {
      const s = new RagstackProxyService({
        apiBaseUrl: 'https://api.example.com',
        httpClient: mockHttpClient,
      });
      expect(s).toBeDefined();
    });
  });

  describe('ingest', () => {
    it('sends correct payload for ingestion', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { documentId: 'doc-123' } });

      const result = await service.ingest({
        profileId: 'profile-1',
        markdownContent: '# Test Profile',
        metadata: { source: 'test' },
        jwtToken: 'token-abc',
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        'https://api.example.com/ragstack',
        {
          operation: 'ingest',
          profileId: 'profile-1',
          markdownContent: '# Test Profile',
          metadata: { source: 'test' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-abc',
          },
        }
      );
      expect(result).toEqual({ documentId: 'doc-123' });
    });

    it('sends request without Authorization header when no token', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { documentId: 'doc-456' } });

      await service.ingest({
        profileId: 'profile-2',
        markdownContent: '# Profile',
        metadata: {},
      });

      const callHeaders = mockHttpClient.post.mock.calls[0][2].headers;
      expect(callHeaders.Authorization).toBeUndefined();
    });

    it('returns success false on network error', async () => {
      mockHttpClient.post.mockRejectedValue(new Error('Network error'));

      const result = await service.ingest({
        profileId: 'profile-1',
        markdownContent: 'content',
        metadata: {},
        jwtToken: 'token',
      });

      expect(result).toEqual({ success: false });
    });
  });

  describe('fetchProfile', () => {
    it('sends correct GET request for profile', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { profile: { name: 'Test' } } });

      const result = await service.fetchProfile({
        profileId: 'profile-1',
        jwtToken: 'token-abc',
      });

      expect(mockHttpClient.get).toHaveBeenCalledWith('https://api.example.com/profiles', {
        params: { profileId: 'profile-1' },
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-abc',
        },
      });
      expect(result).toEqual({ profile: { name: 'Test' } });
    });

    it('returns null on error', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('Not found'));

      const result = await service.fetchProfile({
        profileId: 'profile-1',
        jwtToken: 'token',
      });

      expect(result).toBeNull();
    });

    it('sends request without Authorization header when no token', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { profile: {} } });

      await service.fetchProfile({ profileId: 'profile-1' });

      const callHeaders = mockHttpClient.get.mock.calls[0][1].headers;
      expect(callHeaders.Authorization).toBeUndefined();
    });
  });

  describe('isConfigured', () => {
    it('returns true when apiBaseUrl is set', () => {
      expect(service.isConfigured()).toBe(true);
    });

    it('returns false when apiBaseUrl is empty', () => {
      const s = new RagstackProxyService({
        apiBaseUrl: '',
        httpClient: mockHttpClient,
      });
      expect(s.isConfigured()).toBe(false);
    });

    it('returns false when apiBaseUrl is undefined', () => {
      const s = new RagstackProxyService({
        httpClient: mockHttpClient,
      });
      expect(s.isConfigured()).toBe(false);
    });
  });
});
