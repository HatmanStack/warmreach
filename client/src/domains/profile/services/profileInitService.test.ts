import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileInitService } from './profileInitService';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import axios from 'axios';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#utils/randomHelpers.js', () => ({
  RandomHelpers: {
    randomDelay: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../utils/profileInitStateManager.js', () => ({
  ProfileInitStateManager: {
    isResumingState: vi.fn().mockReturnValue(false),
    validateState: vi.fn(),
    getProgressSummary: vi.fn().mockReturnValue({}),
    updateBatchProgress: vi.fn().mockImplementation((s) => s),
  },
}));

vi.mock('../../linkedin/utils/linkedinErrorHandler.js', () => ({
  LinkedInErrorHandler: {
    categorizeError: vi.fn().mockReturnValue({ category: 'SYSTEM' }),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      if (filePath.includes('index')) {
        return JSON.stringify({
          metadata: { totalAllies: 2, totalIncoming: 0, totalOutgoing: 0 },
          files: { allyConnections: [], incomingConnections: [], outgoingConnections: [] },
          processingState: { completedBatches: [] },
        });
      }
      return JSON.stringify({
        batchNumber: 0,
        connectionType: 'ally',
        connections: ['p1', 'p2'],
      });
    }),
  },
}));

vi.mock('axios');

describe('ProfileInitService', () => {
  let service: ProfileInitService;
  let mockPuppeteer;
  let mockLinkedIn;
  let mockContact;
  let mockDynamo;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPuppeteer = { extractProfilePictures: vi.fn().mockResolvedValue({}) };
    mockLinkedIn = {
      login: vi.fn().mockResolvedValue(true),
      getConnections: vi.fn().mockResolvedValue(['p1', 'p2']),
    };
    mockContact = { scrapeProfile: vi.fn().mockResolvedValue({ success: true }) };
    mockDynamo = {
      setAuthToken: vi.fn(),
      checkEdgeExists: vi.fn().mockResolvedValue(false),
      upsertEdgeStatus: vi.fn().mockResolvedValue(true),
      updateMessages: vi.fn().mockResolvedValue(true),
    };

    service = new ProfileInitService(mockPuppeteer, mockLinkedIn, mockContact, mockDynamo);
  });

  describe('initializeUserProfile', () => {
    it('should complete full initialization successfully', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      const result = await service.initializeUserProfile(state);

      expect(result.success).toBe(true);
      expect(mockLinkedIn.login).toHaveBeenCalled();
      expect(mockLinkedIn.getConnections).toHaveBeenCalled();
      expect(mockDynamo.upsertEdgeStatus).toHaveBeenCalled();
    });

    it('should handle errors and categorize them', async () => {
      const state = { requestId: 'req1' };
      mockLinkedIn.login.mockRejectedValue(new Error('Login failed'));

      await expect(service.initializeUserProfile(state)).rejects.toThrow('Login failed');
      expect(LinkedInErrorHandler.categorizeError).toHaveBeenCalled();
    });
  });

  describe('performProfileScrape', () => {
    it('should call contact service', async () => {
      await service.performProfileScrape('test-id', 'ally');
      expect(mockContact.scrapeProfile).toHaveBeenCalledWith('test-id', 'ally');
    });
  });

  describe('triggerRAGStackIngestion', () => {
    it('should skip if API URL not set', async () => {
      delete process.env.API_GATEWAY_BASE_URL;
      const result = await service.triggerRAGStackIngestion('p1', {});
      expect(result).toBeNull();
    });

    it('should ingest profile if data is available', async () => {
      process.env.API_GATEWAY_BASE_URL = 'https://api.test';
      (axios.get as any).mockResolvedValue({
        data: { profile: { name: 'John Doe', headline: 'Engineer' } },
      });
      (axios.post as any).mockResolvedValue({ data: { documentId: 'doc1' } });

      const result = await service.triggerRAGStackIngestion('p1', { jwtToken: 't' });

      expect(result).toEqual({ documentId: 'doc1' });
      expect(axios.post).toHaveBeenCalled();
    });
  });
});
