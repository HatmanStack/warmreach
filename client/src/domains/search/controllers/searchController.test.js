import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { SearchController } from './searchController.js';
import { SearchRequestValidator } from '../utils/searchRequestValidator.js';
import { SearchStateManager } from '../utils/searchStateManager.js';
import { FileHelpers } from '#utils/fileHelpers.js';

// Mock dependencies
vi.mock('#shared-config/index.js', () => ({
  config: {
    nodeEnv: 'development',
    linkedin: { baseUrl: 'https://www.linkedin.com' },
    paths: { linksFile: 'links.json', goodConnectionsFile: 'good.json' },
  },
}));

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../shared/utils/serviceFactory.js', () => ({
  initializeLinkedInServices: vi.fn().mockResolvedValue({
    linkedInService: { login: vi.fn(), searchCompany: vi.fn(), applyLocationFilter: vi.fn() },
    linkedInContactService: {},
    dynamoDBService: {},
    puppeteerService: {},
  }),
  cleanupLinkedInServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('#utils/fileHelpers.js', () => ({
  FileHelpers: { writeJSON: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../utils/searchRequestValidator.js', () => ({
  SearchRequestValidator: { validateRequest: vi.fn() },
}));

vi.mock('../utils/searchStateManager.js', () => ({
  SearchStateManager: { buildInitialState: vi.fn() },
}));

vi.mock('../../linkedin/utils/linkCollector.js', () => ({
  LinkCollector: vi.fn().mockImplementation(function () {
    return {
      collectAllLinks: vi.fn().mockResolvedValue({ links: ['link1'], pictureUrls: {} }),
    };
  }),
}));

vi.mock('../../linkedin/utils/contactProcessor.js', () => ({
  ContactProcessor: vi.fn().mockImplementation(function () {
    return {
      processAllContacts: vi.fn().mockResolvedValue(['contact1']),
    };
  }),
}));

describe('SearchController', () => {
  let controller;
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new SearchController();

    mockReq = {
      path: '/search',
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: {
        companyName: 'TechCorp',
        companyRole: 'Engineer',
        companyLocation: 'USA',
        linkedinCredentialsCiphertext: 'encrypted',
      },
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  describe('performSearch', () => {
    it('should return 401 if JWT token is missing', async () => {
      mockReq.headers.authorization = undefined;
      process.env.ALLOW_DEV_AUTH_BYPASS = 'false';

      await controller.performSearch(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Missing or invalid Authorization'),
        })
      );
    });

    it('should return 400 if validation fails', async () => {
      SearchRequestValidator.validateRequest.mockReturnValue({
        isValid: false,
        statusCode: 400,
        error: 'Invalid request',
      });

      await controller.performSearch(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request',
        })
      );
    });

    it('should execute full search flow successfully', async () => {
      SearchRequestValidator.validateRequest.mockReturnValue({ isValid: true });
      SearchStateManager.buildInitialState.mockReturnValue({
        companyName: 'TechCorp',
        companyRole: 'Engineer',
        jwtToken: 'test-token',
      });

      const { initializeLinkedInServices } =
        await import('../../../shared/utils/serviceFactory.js');
      const services = await initializeLinkedInServices();
      services.linkedInService.searchCompany.mockResolvedValue('12345');

      await controller.performSearch(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.any(Array),
          metadata: expect.any(Object),
        })
      );
      expect(FileHelpers.writeJSON).toHaveBeenCalled();
    });

    it('should handle search failures with 500 status', async () => {
      SearchRequestValidator.validateRequest.mockReturnValue({ isValid: true });
      SearchStateManager.buildInitialState.mockReturnValue({});

      // Force error in a nested call
      vi.spyOn(controller, 'performSearchFromState').mockRejectedValue(new Error('Search failed'));

      await controller.performSearch(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal server error during search',
        })
      );
    });
  });

  describe('_loadLinksFromFile typed-error narrowing', () => {
    it('returns [] on ENOENT (NodeJS.ErrnoException narrowing)', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      const spy = vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const result = await controller._loadLinksFromFile('/tmp/does-not-exist.json');

      expect(result).toEqual([]);
      spy.mockRestore();
    });

    it('returns [] on other read errors (falls through gracefully)', async () => {
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const spy = vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const result = await controller._loadLinksFromFile('/tmp/no-perms.json');

      expect(result).toEqual([]);
      spy.mockRestore();
    });
  });

  describe('performSearchDirect', () => {
    it('should return result data on success', async () => {
      SearchRequestValidator.validateRequest.mockReturnValue({ isValid: true });
      SearchStateManager.buildInitialState.mockReturnValue({});

      // Mock performSearchFromState directly to avoid complex nested mocks
      vi.spyOn(controller, 'performSearchFromState').mockResolvedValue({
        goodContacts: ['c1'],
        uniqueLinks: ['l1'],
      });

      const payload = { companyName: 'Test', jwtToken: 'token' };
      const result = await controller.performSearchDirect(payload, vi.fn());

      expect(result.statusCode).toBe(200);
      expect(result.response).toEqual(['c1']);
    });
  });
});
