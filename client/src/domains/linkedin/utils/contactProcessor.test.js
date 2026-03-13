import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactProcessor } from './contactProcessor.js';
import { FileHelpers } from '#utils/fileHelpers.js';
import fs from 'fs/promises';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#utils/fileHelpers.js', () => ({
  FileHelpers: { writeJSON: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

describe('ContactProcessor', () => {
  let processor;
  let mockLinkedInService;
  let mockDynamoDBService;
  let mockLocalProfileScraper;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLinkedInService = {
      analyzeContactActivity: vi.fn(),
    };
    mockDynamoDBService = {
      updateProfilePictureUrl: vi.fn(),
      getProfileDetails: vi.fn().mockResolvedValue(true),
      createProfileMetadata: vi.fn().mockResolvedValue({}),
      canScrapeToday: vi.fn().mockResolvedValue(true),
      incrementDailyScrapeCount: vi.fn().mockResolvedValue({}),
    };
    mockLocalProfileScraper = {
      scrapeProfile: vi.fn().mockResolvedValue({
        name: 'Jane Doe',
        headline: 'Engineer',
        location: 'San Francisco',
        about: 'About text',
        currentPosition: { title: 'Engineer', company: 'Acme' },
        experience: [],
        education: [],
        skills: ['JavaScript'],
        recentActivity: [],
      }),
    };
    config = {
      paths: {
        goodConnectionsFile: 'good.json',
        linksFile: 'links.json',
      },
    };

    processor = new ContactProcessor(
      mockLinkedInService,
      mockDynamoDBService,
      config,
      mockLocalProfileScraper
    );
  });

  describe('processAllContacts', () => {
    it('should process contacts and find good ones', async () => {
      const links = ['link1', 'link2'];
      const state = { resumeIndex: 0, jwtToken: 'token' };

      // Mock no existing good contacts
      fs.readFile.mockRejectedValue(new Error('File not found'));

      mockLinkedInService.analyzeContactActivity
        .mockResolvedValueOnce({ isGoodContact: true })
        .mockResolvedValueOnce({ isGoodContact: false });

      const result = await processor.processAllContacts(links, state, vi.fn());

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('link1');
      expect(FileHelpers.writeJSON).toHaveBeenCalledWith('good.json', ['link1']);
    });

    it('should skip certain profiles', async () => {
      const links = ['ACoA_special', 'normal_link'];
      const state = { resumeIndex: 0, jwtToken: 'token' };

      fs.readFile.mockResolvedValue('[]');
      mockLinkedInService.analyzeContactActivity.mockResolvedValue({ isGoodContact: true });

      const result = await processor.processAllContacts(links, state, vi.fn());

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('normal_link');
      expect(mockLinkedInService.analyzeContactActivity).toHaveBeenCalledTimes(1);
    });

    it('should trigger healing after 3 errors in a row if retries fail', async () => {
      const links = ['l1', 'l2', 'l3', 'l4', 'l5'];
      const state = { resumeIndex: 0, jwtToken: 'token' };
      const onHealingNeeded = vi.fn();

      fs.readFile.mockResolvedValue('[]');
      mockLinkedInService.analyzeContactActivity.mockRejectedValue(new Error('fail'));

      // Mock the 5 minute pause
      vi.useFakeTimers();

      const promise = processor.processAllContacts(links, state, onHealingNeeded);

      // Advance timers to pass the 5min delay
      await vi.advanceTimersByTimeAsync(300000);

      await promise;

      expect(onHealingNeeded).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('local scraper integration', () => {
    it('should skip scraping when profile is fresh', async () => {
      const links = ['fresh-profile'];
      const state = { resumeIndex: 0, jwtToken: 'token' };

      fs.readFile.mockRejectedValue(new Error('File not found'));
      mockLinkedInService.analyzeContactActivity.mockResolvedValue({ isGoodContact: true });
      mockDynamoDBService.getProfileDetails.mockResolvedValue(false); // fresh

      await processor.processAllContacts(links, state, vi.fn());

      expect(mockLocalProfileScraper.scrapeProfile).not.toHaveBeenCalled();
    });

    it('should scrape and store metadata when profile is stale', async () => {
      const links = ['stale-profile'];
      const state = { resumeIndex: 0, jwtToken: 'token' };

      fs.readFile.mockRejectedValue(new Error('File not found'));
      mockLinkedInService.analyzeContactActivity.mockResolvedValue({ isGoodContact: true });
      mockDynamoDBService.getProfileDetails.mockResolvedValue(true); // stale

      await processor.processAllContacts(links, state, vi.fn());

      expect(mockLocalProfileScraper.scrapeProfile).toHaveBeenCalledWith('stale-profile');
      expect(mockDynamoDBService.createProfileMetadata).toHaveBeenCalledWith(
        'stale-profile',
        expect.objectContaining({ name: 'Jane Doe' })
      );
    });

    it('should handle scrape failure gracefully', async () => {
      const links = ['error-profile'];
      const state = { resumeIndex: 0, jwtToken: 'token' };

      fs.readFile.mockRejectedValue(new Error('File not found'));
      mockLinkedInService.analyzeContactActivity.mockResolvedValue({ isGoodContact: true });
      mockDynamoDBService.getProfileDetails.mockResolvedValue(true);
      mockLocalProfileScraper.scrapeProfile.mockRejectedValue(new Error('scrape failed'));

      const result = await processor.processAllContacts(links, state, vi.fn());

      // Should still succeed overall, just skip scraping
      expect(result).toHaveLength(1);
    });
  });

  describe('_shouldSkipProfile', () => {
    it('should return true for ACoA profiles', () => {
      expect(processor._shouldSkipProfile('https://linkedin.com/in/ACoAtest')).toBe(true);
    });

    it('should return false for regular profiles', () => {
      expect(processor._shouldSkipProfile('https://linkedin.com/in/johndoe')).toBe(false);
    });
  });
});
