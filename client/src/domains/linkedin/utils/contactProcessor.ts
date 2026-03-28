import { logger } from '#utils/logger.js';
import { FileHelpers } from '#utils/fileHelpers.js';
import fs from 'fs/promises';
import path from 'path';

interface ContactProcessorConfig {
  paths: { linksFile: string; goodConnectionsFile: string };
}

interface LinkedInServiceLike {
  analyzeContactActivity(link: string, jwtToken: string): Promise<{ isGoodContact: boolean }>;
}

interface DynamoDBServiceLike {
  getProfileDetails(link: string): Promise<boolean>;
  canScrapeToday(): Promise<boolean>;
  incrementDailyScrapeCount(): Promise<void>;
  createProfileMetadata(link: string, data: Record<string, string | undefined>): Promise<void>;
  updateProfilePictureUrl(link: string, pictureUrl: string): Promise<void>;
}

interface LocalProfileScraperLike {
  scrapeProfile(link: string): Promise<{
    name: string;
    headline: string;
    currentPosition?: { title?: string; company?: string };
    location: string;
  }>;
}

interface ProcessState {
  resumeIndex: number;
  jwtToken: string;
  companyRole?: string;
  recursionCount: number;
  lastPartialLinksFile?: string;
  [key: string]: unknown;
}

export class ContactProcessor {
  private linkedInService: LinkedInServiceLike;
  private dynamoDBService: DynamoDBServiceLike;
  private config: ContactProcessorConfig;
  private localProfileScraper: LocalProfileScraperLike | null;

  constructor(
    linkedInService: LinkedInServiceLike,
    dynamoDBService: DynamoDBServiceLike,
    config: ContactProcessorConfig,
    localProfileScraper: LocalProfileScraperLike | null
  ) {
    this.linkedInService = linkedInService;
    this.dynamoDBService = dynamoDBService;
    this.config = config;
    this.localProfileScraper = localProfileScraper;
  }

  async processAllContacts(
    uniqueLinks: string[],
    state: ProcessState,
    onHealingNeeded: (params: ProcessState) => Promise<void>,
    pictureUrls: Record<string, string> = {}
  ): Promise<string[] | undefined> {
    const goodContacts: string[] = await this._loadExistingGoodContacts();
    let errorQueue: string[] = [];
    let i = state.resumeIndex;

    while (i < uniqueLinks.length) {
      const link = uniqueLinks[i]!;

      if (this._shouldSkipProfile(link)) {
        i++;
        continue;
      }

      try {
        const result = await this._processContact(
          link,
          state.jwtToken,
          goodContacts,
          i,
          uniqueLinks.length,
          pictureUrls[link]
        );
        if (result.processed) {
          errorQueue = [];
        }
        i++;
      } catch {
        logger.error(`Error collecting contact: ${link}`);
        errorQueue.push(link);
        i++;

        if (errorQueue.length >= 3) {
          const shouldHeal = await this._handleErrorQueue(errorQueue, state.jwtToken, goodContacts);
          errorQueue = [];

          if (shouldHeal) {
            const restartParams = await this._prepareHealingRestart(
              uniqueLinks,
              i,
              errorQueue,
              state
            );
            await onHealingNeeded(restartParams);
            return;
          }
        }
      }
    }

    return goodContacts;
  }

  private async _processContact(
    link: string,
    jwtToken: string,
    goodContacts: string[],
    index: number,
    total: number,
    pictureUrl: string | undefined
  ): Promise<{ processed: boolean }> {
    logger.info(`Analyzing contact ${index + 1}/${total}: ${link}`);
    const result = await this.linkedInService.analyzeContactActivity(link, jwtToken);

    if (result.isGoodContact) {
      goodContacts.push(link);
      logger.info(`Found good contact: ${link} (${goodContacts.length})`);

      // Scrape profile locally if stale and under daily cap
      try {
        const needsScrape = await this.dynamoDBService.getProfileDetails(link);
        const canScrape = await this.dynamoDBService.canScrapeToday();
        if (needsScrape && canScrape && this.localProfileScraper) {
          const scrapedData = await this.localProfileScraper.scrapeProfile(link);
          await this.dynamoDBService.incrementDailyScrapeCount();
          await this.dynamoDBService.createProfileMetadata(link, {
            name: scrapedData.name,
            headline: scrapedData.headline,
            currentTitle: scrapedData.currentPosition?.title,
            currentCompany: scrapedData.currentPosition?.company,
            currentLocation: scrapedData.location,
          });
          logger.info('Profile scraped and metadata stored', { profileId: link });
        } else if (!needsScrape) {
          logger.info('Profile is fresh, skipping scrape', { profileId: link });
        } else if (!canScrape) {
          logger.info('Daily scrape cap reached, skipping scrape', { profileId: link });
        }
      } catch (scrapeError: unknown) {
        const errMsg = scrapeError instanceof Error ? scrapeError.message : String(scrapeError);
        logger.warn(`Local scrape failed for ${link} (non-fatal)`, {
          error: errMsg,
        });
      }

      // Update profile picture URL if available (non-fatal)
      if (pictureUrl) {
        try {
          await this.dynamoDBService.updateProfilePictureUrl(link, pictureUrl);
        } catch {
          logger.warn(`Failed to update profile picture for ${link} (non-fatal)`);
        }
      }

      await FileHelpers.writeJSON(this.config.paths.goodConnectionsFile, goodContacts);
    }

    return { processed: true };
  }

  private async _handleErrorQueue(
    errorQueue: string[],
    jwtToken: string,
    goodContacts: string[]
  ): Promise<boolean> {
    logger.warn(`3 errors in a row, pausing 5min and retrying...`);
    const linksToRetry = [...errorQueue];

    await new Promise((resolve) => setTimeout(resolve, 300000));

    let allRetriesFailed = true;
    for (const retry of linksToRetry) {
      try {
        const retryResult = await this.linkedInService.analyzeContactActivity(retry, jwtToken);
        if (retryResult.isGoodContact) {
          goodContacts.push(retry);
          logger.info(`Retry success: ${retry}`);
          allRetriesFailed = false;
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`Retry failed: ${retry}`, { error: error.message, stack: error.stack });
      }
    }

    return allRetriesFailed;
  }

  private async _prepareHealingRestart(
    uniqueLinks: string[],
    currentIndex: number,
    errorQueue: string[],
    state: ProcessState
  ): Promise<ProcessState> {
    let restartIndex = currentIndex - errorQueue.length;
    if (restartIndex < 0) restartIndex = 0;

    const remainingLinks = uniqueLinks.slice(restartIndex);
    if (remainingLinks[0] !== errorQueue[0]) {
      remainingLinks.unshift(errorQueue[0]!);
    }

    const newPartialLinksFile = path.join(
      path.dirname(this.config.paths.linksFile),
      `possible-links-partial-${Date.now()}.json`
    );

    await fs.writeFile(newPartialLinksFile, JSON.stringify(remainingLinks, null, 2));
    logger.info(`Written partial links file: ${newPartialLinksFile}`);

    return {
      ...state,
      resumeIndex: 0,
      recursionCount: state.recursionCount + 1,
      lastPartialLinksFile: newPartialLinksFile,
    };
  }

  private async _loadExistingGoodContacts(): Promise<string[]> {
    try {
      const fileContent = await fs.readFile(this.config.paths.goodConnectionsFile);
      return JSON.parse(fileContent.toString()) as string[];
    } catch {
      return [];
    }
  }

  private _shouldSkipProfile(link: string): boolean {
    if (/ACoA/.test(link)) {
      logger.debug(`Skipping profile: ${link}`);
      return true;
    }
    return false;
  }
}
