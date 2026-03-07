import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInConnectionService } from './linkedinConnectionService.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock RandomHelpers
vi.mock('#utils/randomHelpers.js', () => ({
  RandomHelpers: {
    randomDelay: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock linkedinResolver
const { mockResolver } = vi.hoisted(() => ({
  mockResolver: {
    resolve: vi.fn(),
    resolveWithWait: vi.fn(),
  },
}));

vi.mock('../../linkedin/selectors/index.js', () => ({
  linkedinResolver: mockResolver,
}));

describe('LinkedInConnectionService', () => {
  let service;
  let mockSessionManager;
  let mockNavigationService;
  let mockDynamoDBService;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPage = buildPuppeteerPage();
    mockSessionManager = {
      getInstance: vi.fn().mockResolvedValue({
        getPage: () => mockPage,
      }),
    };
    mockNavigationService = {
      navigateToProfile: vi.fn().mockResolvedValue(undefined),
    };
    mockDynamoDBService = {
      upsertEdge: vi.fn().mockResolvedValue(true),
    };

    service = new LinkedInConnectionService({
      sessionManager: mockSessionManager,
      navigationService: mockNavigationService,
      dynamoDBService: mockDynamoDBService,
    });
  });

  describe('constructor', () => {
    it('should throw error if sessionManager is missing', () => {
      expect(() => new LinkedInConnectionService({})).toThrow(
        'LinkedInConnectionService requires sessionManager'
      );
    });

    it('should initialize correctly with options', () => {
      expect(service.sessionManager).toBe(mockSessionManager);
      expect(service.navigationService).toBe(mockNavigationService);
      expect(service.dynamoDBService).toBe(mockDynamoDBService);
    });
  });

  describe('sendConnectionRequest', () => {
    it('should send connection request successfully', async () => {
      // Mock status as not connected
      mockResolver.resolve.mockResolvedValue(false);

      // Mock connect button found and send invitation success
      const mockButton = { click: vi.fn(), type: vi.fn() };
      mockResolver.resolveWithWait.mockResolvedValue(mockButton);

      const result = await service.sendConnectionRequest('test-profile-id');

      expect(result.status).toBe('sent');
      expect(result.profileId).toBe('test-profile-id');
      expect(mockNavigationService.navigateToProfile).toHaveBeenCalledWith('test-profile-id');
      expect(mockResolver.resolveWithWait).toHaveBeenCalledWith(
        mockPage,
        'connection:connect-button',
        expect.any(Object)
      );
    });

    it('should handle already connected profile', async () => {
      // Mock status as ally
      mockResolver.resolve.mockImplementation((page, selector) => {
        if (selector === 'connection:distance-1st') return Promise.resolve(true);
        return Promise.resolve(false);
      });

      const result = await service.sendConnectionRequest('test-profile-id');

      expect(result.status).toBe('ally');
      expect(mockResolver.resolveWithWait).not.toHaveBeenCalled();
    });

    it('should handle pending connection request', async () => {
      // Mock status as outgoing
      mockResolver.resolve.mockImplementation((page, selector) => {
        if (selector === 'connection:pending') return Promise.resolve(true);
        return Promise.resolve(false);
      });

      const result = await service.sendConnectionRequest('test-profile-id');

      expect(result.status).toBe('outgoing');
    });

    it('should handle incoming connection request', async () => {
      // Mock status as incoming
      mockResolver.resolve.mockImplementation((page, selector) => {
        if (selector === 'connection:accept') return Promise.resolve(true);
        return Promise.resolve(false);
      });

      const result = await service.sendConnectionRequest('test-profile-id');

      expect(result.status).toBe('incoming');
    });

    it('should send personalized message if provided', async () => {
      mockResolver.resolve.mockResolvedValue(false);
      const mockButton = { click: vi.fn(), type: vi.fn() };
      mockResolver.resolveWithWait.mockResolvedValue(mockButton);

      const result = await service.sendConnectionRequest('test-profile-id', 'Hello John!');

      expect(mockButton.type).toHaveBeenCalledWith('Hello John!', expect.any(Object));
      expect(result.hasPersonalizedMessage).toBe(true);
    });

    it('should record edge in DynamoDB if userId is provided', async () => {
      mockResolver.resolve.mockResolvedValue(false);
      mockResolver.resolveWithWait.mockResolvedValue({ click: vi.fn() });

      await service.sendConnectionRequest('test-profile-id', '', { userId: 'user-123' });

      expect(mockDynamoDBService.upsertEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          targetProfileId: 'test-profile-id',
          edgeType: 'connection_request',
        })
      );
    });

    it('should handle errors during connection request', async () => {
      mockNavigationService.navigateToProfile.mockRejectedValue(new Error('Navigation failed'));

      const result = await service.sendConnectionRequest('test-profile-id');

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Navigation failed');
    });
  });

  describe('checkConnectionStatus', () => {
    it('should return ally when 1st degree connection', async () => {
      mockResolver.resolve.mockImplementation((page, selector) => {
        return Promise.resolve(selector === 'connection:distance-1st');
      });

      const status = await service.checkConnectionStatus();
      expect(status).toBe('ally');
    });

    it('should return outgoing when request is pending', async () => {
      mockResolver.resolve.mockImplementation((page, selector) => {
        return Promise.resolve(selector === 'connection:pending');
      });

      const status = await service.checkConnectionStatus();
      expect(status).toBe('outgoing');
    });

    it('should return incoming when request is received', async () => {
      mockResolver.resolve.mockImplementation((page, selector) => {
        return Promise.resolve(selector === 'connection:accept');
      });

      const status = await service.checkConnectionStatus();
      expect(status).toBe('incoming');
    });

    it('should return not_connected when no status found', async () => {
      mockResolver.resolve.mockResolvedValue(false);

      const status = await service.checkConnectionStatus();
      expect(status).toBe('not_connected');
    });

    it('should return unknown when error occurs', async () => {
      mockResolver.resolve.mockRejectedValue(new Error('Selector error'));

      const status = await service.checkConnectionStatus();
      expect(status).toBe('unknown');
    });
  });
});
