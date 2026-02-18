import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all subpath imports that linkedinService.js and its dependencies use
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#utils/randomHelpers.js', () => ({
  default: {
    randomDelay: vi.fn(() => Promise.resolve()),
    getRandomInt: vi.fn(() => 1000),
  },
}));

vi.mock('#utils/crypto.js', () => ({
  decryptSealboxB64Tag: vi.fn(() => Promise.resolve(null)),
  extractLinkedInCredentials: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('#shared-config/index.js', () => ({
  default: {
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
  },
}));

// Mock DynamoDBService (relative path import)
vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: class MockDynamoDBService {
    constructor() {}
    updateContactStatus() {
      return Promise.resolve();
    }
    getProfiles() {
      return Promise.resolve([]);
    }
  },
}));

// Mock LinkedInContactService (relative path import)
vi.mock('./linkedinContactService.js', () => ({
  default: class MockLinkedInContactService {
    constructor() {}
    processContact() {
      return Promise.resolve();
    }
  },
}));

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

import LinkedInService from './linkedinService.js';

describe('LinkedInService', () => {
  let service;
  let mockPuppeteer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPuppeteer = createMockPuppeteerService();
    service = new LinkedInService(mockPuppeteer);
  });

  describe('constructor', () => {
    it('stores puppeteer service reference', () => {
      expect(service.puppeteer).toBe(mockPuppeteer);
    });

    it('initializes with DynamoDBService', () => {
      expect(service.dynamoDBService).toBeDefined();
    });
  });

  describe('login', () => {
    it('navigates to LinkedIn login page', async () => {
      await service.login('user@test.com', 'pass123');
      expect(mockPuppeteer.goto).toHaveBeenCalledWith('https://www.linkedin.com/login');
    });

    it('types username and password', async () => {
      await service.login('user@test.com', 'pass123');
      expect(mockPuppeteer.safeType).toHaveBeenCalledWith('#username', 'user@test.com');
      expect(mockPuppeteer.safeType).toHaveBeenCalledWith('#password', 'pass123');
    });

    it('clicks login button', async () => {
      await service.login('user@test.com', 'pass123');
      expect(mockPuppeteer.safeClick).toHaveBeenCalledWith('form button[type="submit"]');
    });

    it('throws when username is missing', async () => {
      await expect(service.login('', 'pass123')).rejects.toThrow('username is missing');
    });

    it('throws when password is missing', async () => {
      await expect(service.login('user@test.com', '')).rejects.toThrow('password is missing');
    });

    it('throws when safeType fails for username', async () => {
      mockPuppeteer.safeType.mockResolvedValueOnce(false);
      await expect(service.login('user@test.com', 'pass123')).rejects.toThrow(
        'Failed to enter username'
      );
    });

    it('attempts decryption when credentials ciphertext provided', async () => {
      const { decryptSealboxB64Tag } = await import('#utils/crypto.js');
      decryptSealboxB64Tag.mockResolvedValue(
        JSON.stringify({ email: 'decrypted@test.com', password: 'decryptedpass' })
      );

      await service.login(null, null, false, 'sealbox_x25519:b64:encrypted');
      expect(decryptSealboxB64Tag).toHaveBeenCalledWith('sealbox_x25519:b64:encrypted');
      expect(mockPuppeteer.safeType).toHaveBeenCalledWith('#username', 'decrypted@test.com');
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
      mockPuppeteer.waitForSelector.mockResolvedValue(false);

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
});
