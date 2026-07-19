import { logger } from '#utils/logger.js';
import { FileHelpers } from '#utils/fileHelpers.js';
import fs from 'fs/promises';
import path from 'path';

interface ContactProcessorConfig {
  paths: { linksFile: string; goodConnectionsFile: string };
}

interface SearchContext {
  company?: string;
  role?: string;
  location?: string;
}

interface LinkedInServiceLike {
  // Matches the concrete LinkedInService return (isGoodContact is optional);
  // callers read it as a truthy check. searchContext carries the search-run
  // provenance recorded as edge tags on each good contact.
  analyzeContactActivity(
    link: string,
    jwtToken: string,
    searchContext?: SearchContext
  ): Promise<{ isGoodContact?: boolean }>;
}

interface DynamoDBServiceLike {
  // Return types are widened to match the concrete DynamoDBService (which
  // returns the underlying write result); callers only await for completion.
  getProfileDetails(link: string): Promise<boolean>;
  canScrapeToday(): Promise<boolean>;
  incrementDailyScrapeCount(): Promise<unknown>;
  createProfileMetadata(link: string, data: Record<string, string | undefined>): Promise<unknown>;
}

interface LocalProfileScraperLike {
  scrapeProfile(link: string): Promise<{
    name: string | null;
    headline: string | null;
    location: string | null;
    about?: string | null;
    profilePictureUrl?: string | null;
    currentPosition?: { title?: string; company?: string } | null;
    education?: Array<{ school?: string; degree?: string }>;
    skills?: string[];
  }>;
}

interface ProcessState {
  resumeIndex: number;
  jwtToken: string;
  companyName?: string;
  companyRole?: string;
  companyLocation?: string;
  recursionCount: number;
  lastPartialLinksFile?: string | null;
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
    onHealingNeeded: (params: ProcessState) => Promise<void>
  ): Promise<string[] | undefined> {
    const goodContacts: string[] = await this._loadExistingGoodContacts();
    let errorQueue: string[] = [];
    let i = state.resumeIndex;

    // The search terms that surfaced this batch — recorded as edge provenance on
    // each good contact so first contact can reference why they were found.
    const searchContext: SearchContext = {
      company: state.companyName,
      role: state.companyRole,
      location: state.companyLocation,
    };

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
          searchContext
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
    searchContext?: SearchContext
  ): Promise<{ processed: boolean }> {
    logger.info(`Analyzing contact ${index + 1}/${total}: ${link}`);
    const result = await this.linkedInService.analyzeContactActivity(link, jwtToken, searchContext);

    if (result.isGoodContact) {
      goodContacts.push(link);
      logger.info(`Found good contact: ${link} (${goodContacts.length})`);

      // Scrape profile locally if stale and under daily cap. Mirrors the
      // profile-init connection flow (profileScraping.ts) so search-created
      // connections get the same rich metadata rather than rendering as
      // "Unknown".
      try {
        const needsScrape = await this.dynamoDBService.getProfileDetails(link);
        const canScrape = await this.dynamoDBService.canScrapeToday();
        if (needsScrape && canScrape && this.localProfileScraper) {
          const scrapedData = await this.localProfileScraper.scrapeProfile(link);
          await this.dynamoDBService.incrementDailyScrapeCount();
          const metadata: Record<string, string | undefined> = {
            name: scrapedData.name || '',
            headline: scrapedData.headline || '',
            about: scrapedData.about || '',
            skills: (scrapedData.skills ?? []).join(', '),
            currentTitle: scrapedData.currentPosition?.title || '',
            currentCompany: scrapedData.currentPosition?.company || '',
            currentLocation: scrapedData.location || '',
            education: (scrapedData.education ?? [])
              .map((e) => [e.school, e.degree].filter(Boolean).join(' — '))
              .filter(Boolean)
              .join('; '),
            // Only the photo scraped from the member's own profile page. The
            // list-page picture map mis-resolves to the viewer's own avatar in
            // the 2026 DOM, so writing it would stamp the same wrong photo on
            // everyone — write none and let the UI show initials instead.
            ...(scrapedData.profilePictureUrl
              ? { profilePictureUrl: scrapedData.profilePictureUrl }
              : {}),
          };
          await this.dynamoDBService.createProfileMetadata(link, metadata);
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
        // Fall back to a slug-derived display name so the connection still
        // shows a human-readable name instead of "Unknown" when scraping fails.
        try {
          const name = link
            .replace(/-\d+$/, '')
            .split('-')
            .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
            .join(' ');
          await this.dynamoDBService.createProfileMetadata(link, { name });
        } catch {
          // non-fatal
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
