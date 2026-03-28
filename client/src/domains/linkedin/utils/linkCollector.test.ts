import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkCollector } from './linkCollector.js';
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

describe('LinkCollector', () => {
  let collector;
  let mockLinkedInService;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLinkedInService = {
      getLinksFromPeoplePage: vi.fn(),
    };
    config = {
      linkedin: {
        pageNumberStart: 1,
        pageNumberEnd: 5,
      },
      paths: {
        linksFile: 'links.json',
      },
    };

    collector = new LinkCollector(mockLinkedInService, config);
  });

  describe('collectAllLinks', () => {
    it('should collect links from multiple pages', async () => {
      fs.readFile.mockResolvedValue('[]');
      mockLinkedInService.getLinksFromPeoplePage.mockResolvedValue({
        links: ['link1'],
        pictureUrls: { link1: 'url1' },
      });

      const companyData = { extractedCompanyNumber: '123', extractedGeoNumber: '456' };
      const state = { companyRole: 'Engineer', resumeIndex: 0 };

      const result = await collector.collectAllLinks(state, companyData, vi.fn());

      expect(result.links).toHaveLength(5);
      expect(mockLinkedInService.getLinksFromPeoplePage).toHaveBeenCalledTimes(5);
      expect(FileHelpers.writeJSON).toHaveBeenCalledTimes(5);
    });

    it('should trigger healing after 3 empty pages', async () => {
      fs.readFile.mockResolvedValue('[]');
      mockLinkedInService.getLinksFromPeoplePage.mockResolvedValue({
        links: [],
        pictureUrls: {},
      });

      const companyData = { extractedCompanyNumber: '123', extractedGeoNumber: '456' };
      const state = { resumeIndex: 0 };
      const onHealingNeeded = vi.fn();

      await collector.collectAllLinks(state, companyData, onHealingNeeded);

      expect(onHealingNeeded).toHaveBeenCalledWith(3);
      expect(mockLinkedInService.getLinksFromPeoplePage).toHaveBeenCalledTimes(3);
    });

    it('should handle errors on a page and continue', async () => {
      fs.readFile.mockResolvedValue('[]');
      mockLinkedInService.getLinksFromPeoplePage
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue({ links: ['link2'], pictureUrls: {} });

      const companyData = {};
      const state = { resumeIndex: 0 };

      const result = await collector.collectAllLinks(state, companyData, vi.fn());

      expect(result.links).toHaveLength(4); // 5 pages total, 1st failed
      expect(mockLinkedInService.getLinksFromPeoplePage).toHaveBeenCalledTimes(5);
    });
  });

  describe('_calculateStartPage', () => {
    it('should use pageNumberStart if resumeIndex is 0', () => {
      expect(collector._calculateStartPage(0, 1)).toBe(1);
    });

    it('should use resumeIndex if it is greater than pageNumberStart', () => {
      expect(collector._calculateStartPage(10, 1)).toBe(10);
    });
  });
});
