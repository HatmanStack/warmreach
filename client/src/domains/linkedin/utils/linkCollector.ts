import { logger } from '#utils/logger.js';
import { FileHelpers } from '#utils/fileHelpers.js';
import fs from 'fs/promises';

interface LinkCollectorConfig {
  linkedin: { pageNumberStart: number; pageNumberEnd: number };
  paths: { linksFile: string };
}

interface LinkedInServiceLike {
  getLinksFromPeoplePage(
    pageNumber: number,
    companyNumber: string | null,
    encodedRole: string | null,
    geoNumber: string | null
  ): Promise<{ links: string[]; pictureUrls: Record<string, string> }>;
}

interface CompanyData {
  extractedCompanyNumber: string | null;
  extractedGeoNumber: string | null;
}

interface WorkflowState {
  companyRole?: string;
  resumeIndex: number;
}

interface CollectResult {
  links: string[];
  pictureUrls: Record<string, string>;
}

export class LinkCollector {
  private linkedInService: LinkedInServiceLike;
  private config: LinkCollectorConfig;

  constructor(linkedInService: LinkedInServiceLike, config: LinkCollectorConfig) {
    this.linkedInService = linkedInService;
    this.config = config;
  }

  async collectAllLinks(
    state: WorkflowState,
    companyData: CompanyData,
    onHealingNeeded: (pageNumber: number) => Promise<void>
  ): Promise<CollectResult> {
    const { extractedCompanyNumber, extractedGeoNumber } = companyData;
    const encodedRole = state.companyRole ? encodeURIComponent(state.companyRole) : null;

    const allLinks: string[] = await this._loadExistingLinks();
    const allPictureUrls: Record<string, string> = {};
    const { pageNumberStart, pageNumberEnd } = this.config.linkedin;

    let emptyPageCount = 0;
    let pageNumber = this._calculateStartPage(state.resumeIndex, pageNumberStart);

    while (pageNumber <= pageNumberEnd) {
      try {
        const pageResult = await this.linkedInService.getLinksFromPeoplePage(
          pageNumber,
          extractedCompanyNumber,
          encodedRole,
          extractedGeoNumber
        );

        const { links: pageLinks, pictureUrls } = pageResult;

        if (pageLinks.length === 0) {
          emptyPageCount++;
          if (emptyPageCount >= 3 && pageNumber < pageNumberEnd) {
            await onHealingNeeded(pageNumber);
            return { links: allLinks, pictureUrls: allPictureUrls };
          }
          pageNumber++;
          continue;
        } else {
          emptyPageCount = 0;
        }

        allLinks.push(...pageLinks);
        Object.assign(allPictureUrls, pictureUrls);
        await FileHelpers.writeJSON(this.config.paths.linksFile, allLinks);
        pageNumber++;
      } catch (error) {
        logger.warn(`Error on page ${pageNumber}`, error);
        pageNumber++;
        continue;
      }
    }

    return { links: allLinks, pictureUrls: allPictureUrls };
  }

  private async _loadExistingLinks(): Promise<string[]> {
    try {
      const fileContent = await fs.readFile(this.config.paths.linksFile);
      return JSON.parse(fileContent.toString()) as string[];
    } catch {
      return [];
    }
  }

  _calculateStartPage(resumeIndex: number, pageNumberStart: number): number {
    return resumeIndex !== 0 && resumeIndex > pageNumberStart ? resumeIndex : pageNumberStart;
  }
}
