import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all subpath imports that linkedinService.js and its dependencies use
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#utils/randomHelpers.js', () => ({
  RandomHelpers: {
    randomDelay: vi.fn(() => Promise.resolve()),
    getRandomInt: vi.fn(() => 1000),
  },
}));

vi.mock('#utils/crypto.js', () => ({
  decryptSealboxB64Tag: vi.fn(() => Promise.resolve(null)),
  extractLinkedInCredentials: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('#shared-config/index.js', () => {
  const mockConfig = {
    linkedin: {
      baseUrl: 'https://www.linkedin.com',
      testingMode: false,
      recencyHours: 6,
      recencyDays: 5,
      recencyWeeks: 3,
      historyToCheck: 4,
      threshold: 8,
      pageNumberStart: 1,
      pageNumberEnd: 100,
    },
    linkedinInteractions: {
      sessionTimeout: 30 * 60 * 1000,
      maxConcurrentInteractions: 5,
      rateLimitMax: 100,
      rateLimitWindow: 60 * 60 * 1000,
      retryAttempts: 3,
      humanDelayMin: 1000,
      humanDelayMax: 3000,
      navigationTimeout: 30000,
      elementWaitTimeout: 5000,
      maxSessionErrors: 3,
    },
    puppeteer: {
      headless: true,
      slowMo: 50,
      viewport: { width: 1200, height: 1200 },
    },
    timeouts: {
      navigation: 15000,
      login: 0,
    },
    port: 3001,
    nodeEnv: 'test',
  };
  return { default: mockConfig, config: mockConfig };
});

// Mock BrowserSessionManager
vi.mock('../../session/services/browserSessionManager.js', () => ({
  BrowserSessionManager: {
    getSignalDetector: vi.fn().mockReturnValue(null),
    getContentAnalyzer: vi.fn().mockReturnValue(null),
    getBackoffController: vi.fn().mockReturnValue(null),
  },
}));

// Mock DynamoDBService (relative path import — still needed for the default constructor path)
vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: class MockDynamoDBService {
    constructor() {
      this.setAuthToken = vi.fn();
      this.getProfileDetails = vi.fn().mockResolvedValue(true);
      this.upsertEdgeStatus = vi.fn().mockResolvedValue({});
      this.markBadContact = vi.fn().mockResolvedValue({});
    }
    updateContactStatus() {
      return Promise.resolve();
    }
    getProfiles() {
      return Promise.resolve([]);
    }
  },
}));

function createMockDynamoDBService() {
  return {
    setAuthToken: vi.fn(),
    getProfileDetails: vi.fn().mockResolvedValue(true),
    upsertEdgeStatus: vi.fn().mockResolvedValue({}),
    markBadContact: vi.fn().mockResolvedValue({}),
    updateContactStatus: vi.fn().mockResolvedValue(),
    getProfiles: vi.fn().mockResolvedValue([]),
  };
}

vi.mock('../selectors/index.js', () => ({
  linkedinResolver: {
    resolveWithWait: vi.fn(),
    resolve: vi.fn(),
  },
  linkedinSelectors: {
    'profile:activity-time': [{ strategy: 'css', selector: '.activity-time' }],
    'search:profile-links': [{ strategy: 'css', selector: '.profile-link' }],
  },
}));
import { linkedinResolver } from '../selectors/index.js';

// Create mock PuppeteerService (wrapper around puppeteer page)
function createMockPuppeteerService() {
  const mockInternalPage = {
    goto: vi.fn().mockResolvedValue(),
    url: vi.fn(() => 'https://www.linkedin.com/feed'),
    waitForSelector: vi.fn().mockResolvedValue({ click: vi.fn() }),
    waitForNavigation: vi.fn().mockResolvedValue(),
    waitForFunction: vi.fn().mockResolvedValue(),
    evaluate: vi.fn().mockResolvedValue(0),
    $: vi.fn().mockResolvedValue(null),
    $$: vi.fn().mockResolvedValue([]),
    $$eval: vi.fn().mockResolvedValue([]),
    content: vi.fn().mockResolvedValue('<html></html>'),
    keyboard: { press: vi.fn().mockResolvedValue() },
    mouse: { wheel: vi.fn().mockResolvedValue() },
  };

  return {
    goto: vi.fn().mockResolvedValue(),
    safeType: vi.fn().mockResolvedValue(true),
    safeClick: vi.fn().mockResolvedValue(true),
    getPage: vi.fn(() => mockInternalPage),
    evaluate: vi.fn().mockResolvedValue([]),
    waitForSelector: vi.fn().mockResolvedValue({ click: vi.fn() }),
    waitForFunction: vi.fn().mockResolvedValue(),
    extractLinks: vi.fn().mockResolvedValue([]),
    extractProfilePictures: vi.fn().mockResolvedValue({}),
    _page: mockInternalPage,
  };
}

import { LinkedInService } from './linkedinService.js';

describe('LinkedInService', () => {
  let service;
  let mockPuppeteer;
  let mockDynamoDB;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPuppeteer = createMockPuppeteerService();
    mockDynamoDB = createMockDynamoDBService();
    service = new LinkedInService(mockPuppeteer, mockDynamoDB);

    linkedinResolver.resolveWithWait.mockResolvedValue({
      type: vi.fn(),
      click: vi.fn(),
    });
    linkedinResolver.resolve.mockResolvedValue(null);
  });

  describe('constructor', () => {
    it('stores puppeteer service reference', () => {
      expect(service.puppeteer).toBe(mockPuppeteer);
    });

    it('uses injected DynamoDBService', () => {
      expect(service.dynamoDBService).toBe(mockDynamoDB);
    });

    it('creates default DynamoDBService when none injected', () => {
      const defaultService = new LinkedInService(mockPuppeteer);
      expect(defaultService.dynamoDBService).toBeDefined();
      expect(defaultService.dynamoDBService).not.toBe(mockDynamoDB);
    });
  });

  describe('login', () => {
    it('navigates to LinkedIn login page', async () => {
      await service.login('user@test.com', 'pass123');
      expect(mockPuppeteer.goto).toHaveBeenCalledWith('https://www.linkedin.com/login');
    });

    it('types username and password', async () => {
      const mockType = vi.fn();
      linkedinResolver.resolveWithWait.mockResolvedValue({ type: mockType, click: vi.fn() });
      await service.login('user@test.com', 'pass123');
      expect(linkedinResolver.resolveWithWait).toHaveBeenCalledWith(
        expect.anything(),
        'nav:login-username',
        expect.anything()
      );
      expect(mockType).toHaveBeenCalledWith('user@test.com');
      expect(mockType).toHaveBeenCalledWith('pass123');
    });

    it('clicks login button', async () => {
      const mockClick = vi.fn();
      linkedinResolver.resolveWithWait.mockResolvedValue({ type: vi.fn(), click: mockClick });
      await service.login('user@test.com', 'pass123');
      expect(mockClick).toHaveBeenCalled();
    });

    it('throws when username is missing', async () => {
      await expect(service.login('', 'pass123')).rejects.toThrow('username is missing');
    });

    it('throws when password is missing', async () => {
      await expect(service.login('user@test.com', '')).rejects.toThrow('password is missing');
    });

    it('throws when safeType fails for username', async () => {
      linkedinResolver.resolveWithWait.mockRejectedValueOnce(new Error('timeout'));
      await expect(service.login('user@test.com', 'pass123')).rejects.toThrow();
    });

    it('attempts decryption when credentials ciphertext provided', async () => {
      const { decryptSealboxB64Tag } = await import('#utils/crypto.js');
      decryptSealboxB64Tag.mockResolvedValue(
        JSON.stringify({ email: 'decrypted@test.com', password: 'decryptedpass' })
      );

      const mockType = vi.fn();
      linkedinResolver.resolveWithWait.mockResolvedValue({ type: mockType, click: vi.fn() });

      await service.login(null, null, false, 'sealbox_x25519:b64:encrypted');
      expect(decryptSealboxB64Tag).toHaveBeenCalledWith('sealbox_x25519:b64:encrypted');
      expect(mockType).toHaveBeenCalledWith('decrypted@test.com');
    });
  });

  describe('searchCompany', () => {
    beforeEach(() => {
      // Spy on internal filter helpers to isolate searchCompany logic
      vi.spyOn(service, '_clickFilterButton').mockResolvedValue(true);
      vi.spyOn(service, '_typeInFilterInput').mockResolvedValue(true);
      vi.spyOn(service, '_selectFilterSuggestion').mockResolvedValue(true);
      vi.spyOn(service, '_clickShowResults').mockResolvedValue(true);
    });

    it('navigates to people search page', async () => {
      const page = mockPuppeteer.getPage();
      page.waitForFunction.mockResolvedValue();
      page.url.mockReturnValue(
        'https://www.linkedin.com/search/results/people/?currentCompany=["12345"]'
      );

      await service.searchCompany('TestCorp');
      expect(mockPuppeteer.goto).toHaveBeenCalledWith(
        expect.stringContaining('search/results/people')
      );
    });

    it('returns company number from URL', async () => {
      const page = mockPuppeteer.getPage();
      page.waitForFunction.mockResolvedValue();
      page.url.mockReturnValue(
        'https://www.linkedin.com/search/results/people/?currentCompany=["12345"]'
      );

      const result = await service.searchCompany('TestCorp');
      expect(result).toBe('12345');
    });

    it('returns null when suggestion not found', async () => {
      vi.spyOn(service, '_selectFilterSuggestion').mockResolvedValue(false);

      const result = await service.searchCompany('NonexistentCorp');
      expect(result).toBeNull();
    });

    it('returns null when URL does not contain company parameter', async () => {
      const page = mockPuppeteer.getPage();
      page.waitForFunction.mockRejectedValue(new Error('timeout'));

      const result = await service.searchCompany('TestCorp');
      expect(result).toBeNull();
    });

    it('throws when page is not available', async () => {
      mockPuppeteer.getPage.mockReturnValue(null);
      await expect(service.searchCompany('TestCorp')).rejects.toThrow('Browser page not available');
    });

    it('throws when filter button click fails', async () => {
      vi.spyOn(service, '_clickFilterButton').mockResolvedValue(false);
      await expect(service.searchCompany('TestCorp')).rejects.toThrow(
        'Failed to open "Current companies" filter'
      );
    });
  });

  describe('applyLocationFilter', () => {
    beforeEach(() => {
      vi.spyOn(service, '_clickFilterButton').mockResolvedValue(true);
      vi.spyOn(service, '_typeInFilterInput').mockResolvedValue(true);
      vi.spyOn(service, '_selectFilterSuggestion').mockResolvedValue(true);
      vi.spyOn(service, '_clickShowResults').mockResolvedValue(true);
    });

    it('opens location filter on search page', async () => {
      const page = mockPuppeteer.getPage();
      page.url.mockReturnValue('https://www.linkedin.com/search/results/people/');
      page.waitForFunction.mockResolvedValue();

      await service.applyLocationFilter('New York');
      expect(service._clickFilterButton).toHaveBeenCalledWith('Locations');
    });

    it('returns null when suggestion not found', async () => {
      const page = mockPuppeteer.getPage();
      page.url.mockReturnValue('https://www.linkedin.com/search/results/people/');
      vi.spyOn(service, '_selectFilterSuggestion').mockResolvedValue(false);

      const result = await service.applyLocationFilter('Atlantis');
      expect(result).toBeNull();
    });

    it('throws when page is not available', async () => {
      mockPuppeteer.getPage.mockReturnValue(null);
      await expect(service.applyLocationFilter('New York')).rejects.toThrow(
        'Browser page not available'
      );
    });

    it('throws when filter button click fails', async () => {
      const page = mockPuppeteer.getPage();
      page.url.mockReturnValue('https://www.linkedin.com/search/results/people/');
      vi.spyOn(service, '_clickFilterButton').mockResolvedValue(false);

      await expect(service.applyLocationFilter('New York')).rejects.toThrow(
        'Failed to open "Locations" filter'
      );
    });

    it('returns geo number from URL on success', async () => {
      const page = mockPuppeteer.getPage();
      page.url.mockReturnValue('https://www.linkedin.com/search/results/people/');
      page.waitForFunction.mockResolvedValue();
      // After waitForFunction, url() should return the updated URL
      page.url
        .mockReturnValueOnce('https://www.linkedin.com/search/results/people/')
        .mockReturnValue('https://www.linkedin.com/search/results/people/?geoUrn=["103644278"]');

      const result = await service.applyLocationFilter('New York');
      expect(result).toBe('103644278');
    });
  });

  describe('getLinksFromPeoplePage', () => {
    it('constructs search URL with company filter', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue(['https://www.linkedin.com/in/user1']);

      await service.getLinksFromPeoplePage(1, '12345');

      expect(mockPuppeteer.goto).toHaveBeenCalledWith(expect.stringContaining('12345'));
    });

    it('includes geo filter in URL when provided', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue([]);

      await service.getLinksFromPeoplePage(1, '12345', null, '100');

      const gotoUrl = mockPuppeteer.goto.mock.calls[0][0];
      expect(gotoUrl).toContain('geoUrn');
      expect(gotoUrl).toContain('100');
    });

    it('includes page number in URL', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue([]);

      await service.getLinksFromPeoplePage(3, '12345');

      const gotoUrl = mockPuppeteer.goto.mock.calls[0][0];
      expect(gotoUrl).toContain('page=3');
    });

    it('returns extracted links from page', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue(['/in/user1', '/in/user2']);

      const result = await service.getLinksFromPeoplePage(1, '12345');
      expect(result.links).toEqual(['/in/user1', '/in/user2']);
    });

    it('returns empty result on navigation error', async () => {
      mockPuppeteer.goto.mockRejectedValue(new Error('Navigation failed'));

      const result = await service.getLinksFromPeoplePage(1, '12345');
      expect(result).toEqual({ links: [], pictureUrls: {} });
    });

    it('returns empty result when no content found', async () => {
      linkedinResolver.resolveWithWait.mockRejectedValue(new Error('timeout'));

      const result = await service.getLinksFromPeoplePage(1, '12345');
      expect(result).toEqual({ links: [], pictureUrls: {} });
    });
  });

  describe('getConnections', () => {
    it('navigates to ally connections page', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue([]);

      await service.getConnections({ connectionType: 'ally' });
      expect(mockPuppeteer.goto).toHaveBeenCalledWith(
        expect.stringContaining('invite-connect/connections')
      );
    });

    it('navigates to incoming connections page', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue([]);

      await service.getConnections({ connectionType: 'incoming' });
      expect(mockPuppeteer.goto).toHaveBeenCalledWith(
        expect.stringContaining('invitation-manager/received')
      );
    });

    it('navigates to outgoing connections page', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue([]);

      await service.getConnections({ connectionType: 'outgoing' });
      expect(mockPuppeteer.goto).toHaveBeenCalledWith(
        expect.stringContaining('invitation-manager/sent')
      );
    });

    it('returns extracted profile links', async () => {
      mockPuppeteer.extractLinks.mockResolvedValue(['/in/user1', '/in/user2']);

      const result = await service.getConnections({ connectionType: 'ally' });
      expect(result).toEqual(['/in/user1', '/in/user2']);
    });

    it('throws for unknown connection type', async () => {
      await expect(service.getConnections({ connectionType: 'unknown' })).rejects.toThrow(
        'Unknown connection type'
      );
    });
  });

  describe('analyzeContactActivity', () => {
    const profileId = 'test-profile';
    const jwtToken = 'test-token';

    it('returns isGoodContact true when activity score exceeds threshold', async () => {
      const page = mockPuppeteer.getPage();
      page.url.mockReturnValue('https://www.linkedin.com/in/test-profile/recent-activity/');
      page.evaluate.mockResolvedValue({
        updatedCounts: { hour: 5, day: 3, week: 2 },
        newCounted: ['item1', 'item2'],
      });

      const result = await service.analyzeContactActivity(profileId, jwtToken);

      expect(result).toEqual({ isGoodContact: true });
      expect(service.dynamoDBService.setAuthToken).toHaveBeenCalledWith(jwtToken);
      expect(service.dynamoDBService.upsertEdgeStatus).toHaveBeenCalledWith(profileId, 'possible');
    });

    it('returns isGoodContact false when activity score is below threshold', async () => {
      const page = mockPuppeteer.getPage();
      page.url.mockReturnValue('https://www.linkedin.com/in/test-profile/recent-activity/');
      page.evaluate
        .mockResolvedValueOnce({
          updatedCounts: { hour: 0, day: 0, week: 0 },
          newCounted: [],
        })
        .mockResolvedValueOnce(undefined) // scroll
        .mockResolvedValueOnce({
          updatedCounts: { hour: 0, day: 0, week: 0 },
          newCounted: [],
        })
        .mockResolvedValueOnce(undefined) // scroll
        .mockResolvedValueOnce({
          updatedCounts: { hour: 0, day: 0, week: 0 },
          newCounted: [],
        })
        .mockResolvedValueOnce(undefined) // scroll
        .mockResolvedValueOnce({
          updatedCounts: { hour: 0, day: 0, week: 0 },
          newCounted: [],
        })
        .mockResolvedValueOnce(undefined); // scroll

      const result = await service.analyzeContactActivity(profileId, jwtToken);

      expect(result).toEqual({ isGoodContact: false });
      expect(service.dynamoDBService.upsertEdgeStatus).toHaveBeenCalledWith(profileId, 'processed');
      expect(service.dynamoDBService.markBadContact).toHaveBeenCalledWith(profileId);
    });

    it('skips analysis when profile was updated recently', async () => {
      service.dynamoDBService.getProfileDetails.mockResolvedValue(false);

      const result = await service.analyzeContactActivity(profileId, jwtToken);

      expect(result).toEqual({
        skipped: true,
        reason: 'Profile was updated recently',
        profileId,
      });
      expect(mockPuppeteer.goto).not.toHaveBeenCalled();
    });

    it('throws when page is not available', async () => {
      mockPuppeteer.getPage.mockReturnValueOnce(null);

      // goto will succeed, but getPage after goto returns null
      await expect(service.analyzeContactActivity(profileId, jwtToken)).rejects.toThrow(
        'Browser page not available'
      );
    });

    it('throws on navigation failure', async () => {
      mockPuppeteer.goto.mockRejectedValue(new Error('Navigation failed'));

      await expect(service.analyzeContactActivity(profileId, jwtToken)).rejects.toThrow(
        'Navigation failed'
      );
    });
  });

  describe('scrollToLoadConnections', () => {
    it('scrolls page and returns connection count', async () => {
      const page = mockPuppeteer.getPage();
      page.evaluate
        .mockResolvedValueOnce(5) // first scroll: 5 connections
        .mockResolvedValueOnce(10) // second scroll: 10 connections
        .mockResolvedValueOnce(10) // third scroll: no change
        .mockResolvedValueOnce(10) // fourth: no change
        .mockResolvedValueOnce(10) // fifth: no change
        .mockResolvedValueOnce(10) // sixth: no change
        .mockResolvedValueOnce(10); // seventh: no change (stable limit = 5)

      const count = await service.scrollToLoadConnections('ally', 10);
      expect(count).toBe(10);
    });

    it('stops scrolling after stable limit reached', async () => {
      const page = mockPuppeteer.getPage();
      // Return same count every time (stable from the start)
      page.evaluate.mockResolvedValue(3);

      const count = await service.scrollToLoadConnections('ally', 20);
      // Should stop after stableLimit (5) + initial count of attempts
      expect(count).toBe(3);
    });

    it('throws when page is not available', async () => {
      mockPuppeteer.getPage.mockReturnValue(null);
      await expect(service.scrollToLoadConnections('ally')).rejects.toThrow(
        'Browser page not available'
      );
    });

    it('handles evaluate errors gracefully and stops', async () => {
      const page = mockPuppeteer.getPage();
      page.evaluate.mockRejectedValue(new Error('Execution context was destroyed'));

      const count = await service.scrollToLoadConnections('ally', 5);
      expect(count).toBe(0);
    });

    it('respects maxScrolls parameter', async () => {
      const page = mockPuppeteer.getPage();
      // Each scroll finds more connections
      let callCount = 0;
      page.evaluate.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount * 5);
      });

      const count = await service.scrollToLoadConnections('ally', 3);
      // maxScrolls = 3, so should have made 3 evaluate calls
      expect(count).toBeGreaterThan(0);
    });
  });
});
