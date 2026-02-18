import config from '#shared-config/index.js';
import { logger } from '#utils/logger.js';
import RandomHelpers from '#utils/randomHelpers.js';
import DynamoDBService from '../../storage/services/dynamoDBService.js';
import { decryptSealboxB64Tag } from '#utils/crypto.js';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';

/**
 * Connection type options
 */
export type ConnectionType = 'ally' | 'incoming' | 'outgoing';

/**
 * Options for getConnections method
 */
export interface GetConnectionsOptions {
  connectionType?: ConnectionType;
  maxScrolls?: number;
}

/**
 * Result of contact analysis
 */
export interface ContactAnalysisResult {
  isGoodContact?: boolean;
  skipped?: boolean;
  reason?: string;
  profileId?: string;
}

/**
 * Activity counts by timeframe
 */
interface ActivityCounts {
  hour: number;
  day: number;
  week: number;
}

/**
 * LinkedIn service for browser automation.
 * Handles login, search, profile analysis, and connection management.
 */
export class LinkedInService {
  private puppeteer: PuppeteerService;
  private dynamoDBService: DynamoDBService;

  constructor(puppeteerService: PuppeteerService) {
    this.puppeteer = puppeteerService;
    this.dynamoDBService = new DynamoDBService();
  }

  /**
   * Execute a callback after a random delay. The delay is integral to the
   * return path — removing it breaks the function.
   */
  private async _paced<T>(minMs: number, maxMs: number, fn: () => Promise<T>): Promise<T> {
    await RandomHelpers.randomDelay(minMs, maxMs);
    return await fn();
  }

  async login(
    username: string | null | undefined,
    password: string | null | undefined,
    recursion: boolean,
    credentialsCiphertext: string | null = null,
    _sessionTag: string = 'default'
  ): Promise<boolean> {
    try {
      logger.info('Starting LinkedIn login process...');

      let loginUsername = username;
      let loginPassword = password;

      // Just-in-time decryption if plaintext not provided
      if (
        (!loginUsername || !loginPassword) &&
        typeof credentialsCiphertext === 'string' &&
        credentialsCiphertext.startsWith('sealbox_x25519:b64:')
      ) {
        try {
          const decrypted = await decryptSealboxB64Tag(credentialsCiphertext);
          if (decrypted) {
            const obj = JSON.parse(decrypted) as { email?: string; password?: string };
            loginUsername = obj?.email || loginUsername;
            loginPassword = obj?.password || loginPassword;
          }
        } catch (err) {
          const error = err as Error;
          logger.error('Failed to decrypt LinkedIn credentials for login', {
            error: error.message,
            stack: error.stack,
          });
          throw new Error(`Credential decryption failed: ${error.message}`);
        }
      }

      // Validate credentials before interacting with the page
      if (typeof loginUsername !== 'string' || loginUsername.trim().length === 0) {
        throw new Error('LinkedIn username is missing or invalid');
      }
      if (typeof loginPassword !== 'string' || loginPassword.trim().length === 0) {
        throw new Error('LinkedIn password is missing or invalid');
      }

      await this.puppeteer.goto(`${config.linkedin.baseUrl}/login`);

      // Fill username
      const usernameSuccess = await this.puppeteer.safeType('#username', loginUsername);
      if (!usernameSuccess) {
        throw new Error('Failed to enter username');
      }

      // Fill password
      const passwordSuccess = await this.puppeteer.safeType('#password', loginPassword);
      if (!passwordSuccess) {
        throw new Error('Failed to enter password');
      }

      // Click login button
      const loginSuccess = await this.puppeteer.safeClick('form button[type="submit"]');
      if (!loginSuccess) {
        throw new Error('Failed to click login button');
      }

      if (recursion) {
        logger.warn(
          'Recursion detected: repeated login/redirect loop during authentication. If using 2FA, consider disabling it or enabling an automated 2FA bypass for this flow.'
        );
      }

      // Post-login: do a short readiness probe instead of long navigation waits
      const page = this.puppeteer.getPage();
      if (!page) {
        throw new Error('Browser page not available');
      }

      const shortCapMs = Math.min(8000, config.timeouts?.navigation || 15000);
      const start = Date.now();
      try {
        await Promise.race([
          page.waitForFunction(() => document.readyState === 'complete', { timeout: shortCapMs }),
          page.waitForSelector('header, [data-view-name="navigation-homepage"]', {
            timeout: shortCapMs / 2,
          }),
        ]);
      } catch {
        // Intentionally swallowed: LinkedIn is an SPA that may not trigger traditional
        // navigation events. The subsequent waitForSelector() with configurable timeout
        // handles the actual login verification. This race is just an optimization.
      }
      const spent = Date.now() - start;
      logger.debug(`Post-login readiness probe took ${spent}ms`);

      // After login, wait for a common homepage selector to allow time for security challenges (2FA, checkpoint, captcha)
      const homepageSelector = [
        '[data-view-name="navigation-homepage"]',
        '[data-view-name="identity-module"]',
        '[data-view-name="identity-self-profile"]',
        'header',
      ].join(', ');

      // Timeout of 0 means "wait indefinitely" - this is intentional to allow users
      // to manually complete 2FA/CAPTCHA challenges.
      const loginWaitMs = config.timeouts?.login ?? 0;
      try {
        await page.waitForSelector(homepageSelector, { visible: true, timeout: loginWaitMs });
        logger.info(
          'Homepage element detected after login; security challenge (if any) likely resolved.'
        );
      } catch (e) {
        logger.error('Homepage selector did not appear within the configured login timeout.', e);
        throw e;
      }

      logger.info('Login process completed');
      return true;
    } catch (error) {
      logger.error('Login failed:', error);
      throw error;
    }
  }

  async searchCompany(companyName: string): Promise<string | null> {
    try {
      logger.info(`Extracting company ID via people search filter: ${companyName}`);

      const page = this.puppeteer.getPage();
      if (!page) {
        throw new Error('Browser page not available');
      }

      await this.puppeteer.goto(`${config.linkedin.baseUrl}/search/results/people/`);

      // Click "Current companies" filter label
      const companyFilterClicked = await this._paced(1500, 2500, () =>
        this._clickFilterButton('Current companies')
      );
      if (!companyFilterClicked) {
        throw new Error('Failed to open "Current companies" filter');
      }

      // Type company name in the filter search input
      const filterInputTyped = await this._paced(500, 1000, () =>
        this._typeInFilterInput(companyName)
      );
      if (!filterInputTyped) {
        throw new Error('Failed to type company name in filter input');
      }

      // Select the first matching suggestion
      const suggestionClicked = await this._paced(1500, 2500, () =>
        this._selectFilterSuggestion(companyName)
      );
      if (!suggestionClicked) {
        logger.warn(`No matching company suggestion found for: ${companyName}`);
        return null;
      }

      // Click "Show results" to apply the filter (may auto-apply on selection)
      await this._paced(500, 1000, () => this._clickShowResults());

      // Wait for URL to update with company parameter
      let extractedCompanyNumber: string | null = null;
      try {
        await page.waitForFunction(
          () => /currentCompany=/.test(decodeURIComponent(window.location.href)),
          { timeout: 10000 }
        );
        const currentUrl = decodeURIComponent(page.url());
        const companyMatch = currentUrl.match(/currentCompany=\["?(\d+)"?\]/);
        extractedCompanyNumber = companyMatch?.[1] ?? null;
      } catch {
        logger.warn('Timed out waiting for company parameter in URL');
      }

      if (extractedCompanyNumber) {
        logger.info(`Extracted company number: ${extractedCompanyNumber}`);
      } else {
        logger.warn('Could not extract company ID from URL');
      }

      return extractedCompanyNumber;
    } catch (error) {
      logger.error(`Failed to extract Company ID for ${companyName}:`, error);
      throw error;
    }
  }

  async applyLocationFilter(companyLocation: string): Promise<string | null> {
    try {
      logger.info(`Applying location filter via people search: ${companyLocation}`);

      const page = this.puppeteer.getPage();
      if (!page) {
        throw new Error('Browser page not available');
      }

      // Ensure we're on the people search page
      if (!page.url().includes('/search/results/people')) {
        await this.puppeteer.goto(`${config.linkedin.baseUrl}/search/results/people/`);
      }

      // Click "Locations" filter button
      const locationFilterClicked = await this._paced(1500, 2500, () =>
        this._clickFilterButton('Locations')
      );
      if (!locationFilterClicked) {
        throw new Error('Failed to open "Locations" filter');
      }

      // Type location in the filter search input
      const filterInputTyped = await this._paced(500, 1000, () =>
        this._typeInFilterInput(companyLocation)
      );
      if (!filterInputTyped) {
        throw new Error('Failed to type location in filter input');
      }

      // Select the first matching suggestion
      const suggestionClicked = await this._paced(1500, 2500, () =>
        this._selectFilterSuggestion(companyLocation)
      );
      if (!suggestionClicked) {
        logger.warn(`No matching location suggestion found for: ${companyLocation}`);
        return null;
      }

      // Click "Show results" to apply the filter (may auto-apply on selection)
      await this._paced(500, 1000, () => this._clickShowResults());

      // Wait for URL to update with geo parameter
      let extractedGeoNumber: string | null = null;
      try {
        await page.waitForFunction(() => /geoUrn=/.test(decodeURIComponent(window.location.href)), {
          timeout: 10000,
        });
        const currentUrl = decodeURIComponent(page.url());
        const geoMatch = currentUrl.match(/geoUrn=\["?(\d+)"?\]/);
        extractedGeoNumber = geoMatch?.[1] ?? null;
      } catch {
        logger.warn('Timed out waiting for geoUrn parameter in URL');
      }

      if (extractedGeoNumber) {
        logger.info(`Extracted geo number: ${extractedGeoNumber}`);
      } else {
        logger.warn('Could not extract geo ID from URL');
      }

      return extractedGeoNumber;
    } catch (error) {
      logger.error('Failed to apply location filter:', error);
      throw error;
    }
  }

  private async _clickFilterButton(filterName: string): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    const selectors = [
      `::-p-aria(${filterName})`,
      `button[aria-label="${filterName} filter"]`,
      `button[aria-label*="${filterName}"]`,
    ];

    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const success = await this.puppeteer.safeClick(selector);
        if (success) {
          logger.debug(`Clicked filter "${filterName}" with: ${selector}`);
          return true;
        }
      } catch {
        logger.debug(`Filter selector failed: ${selector}`);
      }
    }

    // Fallback: find by text content in both buttons and labels
    try {
      const clicked = await page.evaluate((name: string) => {
        const elements = Array.from(document.querySelectorAll('button, label'));
        const match = elements.find((el) => {
          const text = el.textContent?.trim().toLowerCase() ?? '';
          return text.includes(name.toLowerCase());
        });
        if (match) {
          (match as HTMLElement).click();
          return true;
        }
        return false;
      }, filterName);
      if (clicked) {
        logger.debug(`Clicked filter "${filterName}" via text content fallback`);
        return true;
      }
    } catch {
      // ignore
    }

    logger.warn(`Could not find filter: ${filterName}`);
    return false;
  }

  private async _typeInFilterInput(text: string): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    const inputSelectors = [
      'input[aria-label*="Add a company"]',
      'input[aria-label*="Add a location"]',
      'input[placeholder*="Add a"]',
      'input[role="combobox"]',
      '[role="listbox"] input',
      'fieldset input[type="text"]',
    ];

    for (const selector of inputSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click({ count: 3 });
          await page.keyboard.press('Backspace');
          await element.type(text, { delay: 50 });
          logger.debug(`Typed "${text}" in filter input: ${selector}`);
          return true;
        }
      } catch {
        logger.debug(`Filter input selector failed: ${selector}`);
      }
    }

    logger.warn('Could not find filter input field');
    return false;
  }

  private async _selectFilterSuggestion(searchText: string): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    const suggestionSelectors = [
      '[role="listbox"] [role="option"]',
      '[role="listbox"] li',
      '.basic-typeahead__triggered-content li',
      'div[data-basic-filter-parameter-values] label',
      'fieldset label',
    ];

    for (const selector of suggestionSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const clicked = await page.evaluate(
          (sel: string, text: string) => {
            const items = Array.from(document.querySelectorAll(sel));
            const exactMatch = items.find(
              (item) => item.textContent?.trim().toLowerCase() === text.toLowerCase()
            );
            const partialMatch = items.find((item) =>
              item.textContent?.trim().toLowerCase().includes(text.toLowerCase())
            );
            const target = exactMatch || partialMatch;
            if (target) {
              const input = target.querySelector('input') as HTMLInputElement | null;
              if (input) {
                input.click();
              } else {
                (target as HTMLElement).click();
              }
              return true;
            }
            return false;
          },
          selector,
          searchText
        );

        if (clicked) {
          logger.debug(`Selected suggestion for "${searchText}" with: ${selector}`);
          return true;
        }
      } catch {
        logger.debug(`Suggestion selector failed: ${selector}`);
      }
    }

    logger.warn(`No suggestions found for: ${searchText}`);
    return false;
  }

  private async _clickShowResults(): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    const selectors = [
      '::-p-aria(Show results)',
      '::-p-aria(Apply current filter)',
      'button[aria-label*="Apply"]',
      'button[aria-label*="Show results"]',
      'button[data-control-name="filter_show_results"]',
    ];

    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        const success = await this.puppeteer.safeClick(selector);
        if (success) {
          logger.debug(`Clicked "Show results" with: ${selector}`);
          return true;
        }
      } catch {
        // try next
      }
    }

    // Fallback: find by button text
    try {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const btn = buttons.find((b) => {
          const text = b.textContent?.trim().toLowerCase() ?? '';
          return text.includes('show results') || text.includes('apply');
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        logger.debug('Clicked "Show results" via text content fallback');
        return true;
      }
    } catch {
      // ignore
    }

    // If no explicit apply button, the filter may auto-apply on selection
    logger.debug('No "Show results" button found - filter may have auto-applied');
    return false;
  }

  async getLinksFromPeoplePage(
    pageNumber: number,
    extractedCompanyNumber: string | null = null,
    encodedRole: string | null = null,
    extractedGeoNumber: string | null = null
  ): Promise<{ links: string[]; pictureUrls: Record<string, string> }> {
    try {
      // Build URL conditionally based on available parameters
      const urlParts = [`${config.linkedin.baseUrl}/search/results/people/?`];
      const queryParams: string[] = [];

      if (extractedCompanyNumber) {
        queryParams.push(`currentCompany=%5B"${extractedCompanyNumber}"%5D`);
      }

      if (extractedGeoNumber) {
        queryParams.push(`geoUrn=%5B"${extractedGeoNumber}"%5D`);
      }

      if (encodedRole) {
        queryParams.push(`keywords=${encodedRole}`);
      }

      queryParams.push('origin=FACETED_SEARCH');
      queryParams.push(`page=${pageNumber}`);

      const url = urlParts[0] + queryParams.join('&');

      logger.debug(`Fetching links from page ${pageNumber}: ${url}`);

      await this.puppeteer.goto(url);

      // Wait for content to load
      const hasContent = await this.puppeteer.waitForSelector('ul li', { timeout: 5000 });
      if (!hasContent) {
        logger.warn(`No content found on page ${pageNumber}`);
        return { links: [], pictureUrls: {} };
      }

      const links = await this.puppeteer.extractLinks();
      logger.debug(`Found ${links.length} links on page ${pageNumber}`);

      // Extract profile picture URLs from the same page (no extra navigation)
      let pictureUrls: Record<string, string> = {};
      try {
        pictureUrls = await this.puppeteer.extractProfilePictures();
      } catch {
        // non-fatal
      }

      return { links, pictureUrls };
    } catch (error) {
      // Return empty result instead of throwing to allow pagination to continue.
      logger.error(`Failed to get links from page ${pageNumber}:`, error);
      return { links: [], pictureUrls: {} };
    }
  }

  async analyzeContactActivity(
    profileId: string,
    jwtToken: string
  ): Promise<ContactAnalysisResult> {
    try {
      logger.info('Starting contact activity analysis', { profileId });
      this.dynamoDBService.setAuthToken(jwtToken);
      const shouldProcess = await this.dynamoDBService.getProfileDetails(profileId);
      logger.info('Profile details check completed', { profileId, shouldProcess });
      if (!shouldProcess) {
        logger.info(`Skipping analysis for ${profileId}: Profile was updated recently`);
        return {
          skipped: true,
          reason: 'Profile was updated recently',
          profileId,
        };
      }

      logger.info(`Proceeding with analysis for ${profileId}`);

      const activityUrl = `${config.linkedin.baseUrl}/in/${profileId}/recent-activity/reactions/`;
      logger.debug(`Analyzing contact activity: ${activityUrl}`);

      await this.puppeteer.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      const page = this.puppeteer.getPage();
      if (!page) {
        throw new Error('Browser page not available');
      }

      const currentUrl = page.url();

      // Detection of security challenges
      const pageContent = await page.content();
      if (currentUrl.includes('checkpoint') || /captcha|verify/i.test(pageContent)) {
        logger.warn('Landed on a checkpoint or captcha page - may require manual intervention');
      }

      let score = 0;
      const totalCounts: ActivityCounts = { hour: 0, day: 0, week: 0 };
      const { recencyHours, recencyDays, recencyWeeks, historyToCheck } = config.linkedin;
      logger.debug(
        `Recency settings - Hours: ${recencyHours}, Days: ${recencyDays}, Weeks: ${recencyWeeks}`
      );
      const countedSet = new Set<string>();

      for (let i = 0; i < historyToCheck; i++) {
        const timeSelector = 'span[aria-hidden="true"], p[componentkey]';
        await this.puppeteer.waitForSelector(timeSelector, { timeout: 5000 });

        const result = await page.evaluate(
          (existingCounts: ActivityCounts, countedArr: string[]) => {
            const timeframes: Record<string, RegExp> = {
              hour: /\b([1-9]|1[0-9]|2[0-3])h\b/i,
              day: /\b([1-6])d\b/i,
              week: /\b([1-4])w\b/i,
            };
            const elements = Array.from(
              document.querySelectorAll('span[aria-hidden="true"], p[componentkey]')
            );
            const updatedCounts = { ...existingCounts };
            const newCounted: string[] = [];

            elements.forEach((el, idx) => {
              const key = `${el.textContent?.toLowerCase() ?? ''}|${idx}|${el.outerHTML}`;
              if (!countedArr.includes(key)) {
                Object.entries(timeframes).forEach(([k, regex]) => {
                  if (regex.test(el.textContent?.toLowerCase() ?? '')) {
                    updatedCounts[k as keyof typeof updatedCounts]++;
                  }
                });
                newCounted.push(key);
              }
            });

            return { updatedCounts, newCounted };
          },
          totalCounts,
          Array.from(countedSet)
        );

        Object.assign(totalCounts, result.updatedCounts);
        result.newCounted.forEach((key: string) => countedSet.add(key));

        score =
          totalCounts.day * recencyDays +
          totalCounts.hour * recencyHours +
          totalCounts.week * recencyWeeks;

        logger.debug(`Contact ${profileId} - Iteration ${i + 1}, Score: ${score}`);

        if (score >= config.linkedin.threshold) {
          break;
        }

        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
        });
      }

      const isGoodContact = score >= config.linkedin.threshold;
      logger.debug(`Contact ${profileId} final score: ${score}, Good contact: ${isGoodContact}`);

      if (isGoodContact) {
        await this.dynamoDBService.upsertEdgeStatus(profileId, 'possible');
        return { isGoodContact: true };
      }
      await this.dynamoDBService.upsertEdgeStatus(profileId, 'processed');
      await this.dynamoDBService.markBadContact(profileId);

      return { isGoodContact: false };
    } catch (error) {
      logger.error(`Failed to analyze contact activity for ${profileId}:`, error);
      throw error;
    }
  }

  /**
   * Scroll to load connections with intelligent detection of when to stop
   */
  async scrollToLoadConnections(
    connectionType: ConnectionType,
    maxScrolls: number = 5
  ): Promise<number> {
    const page = this.puppeteer.getPage();
    if (!page) {
      throw new Error('Browser page not available');
    }

    let previousConnectionCount = 0;
    let stableCount = 0;
    const stableLimit = 5;

    logger.info(
      `Starting intelligent scroll for ${connectionType} connections (max ${maxScrolls} scrolls)`
    );

    for (let i = 0; i < maxScrolls; i++) {
      try {
        const currentConnectionCount = await page.evaluate(() => {
          const selectors = [
            'a[href*="/in/"]',
            '[data-view-name="connections-profile"]',
            '[data-view-name="people-search-result"]',
            '[data-test-id="connection-card"]',
          ];

          let totalCount = 0;
          selectors.forEach((selector) => {
            const elements = document.querySelectorAll(selector);
            totalCount = Math.max(totalCount, elements.length);
          });

          return totalCount;
        });

        if (currentConnectionCount > previousConnectionCount) {
          logger.debug(
            `Scroll ${i + 1}: Found ${currentConnectionCount} connections (+${currentConnectionCount - previousConnectionCount})`
          );
          previousConnectionCount = currentConnectionCount;
          stableCount = 0;
        } else {
          stableCount++;
          logger.debug(
            `Scroll ${i + 1}: No new connections found (${currentConnectionCount} total, stable count: ${stableCount})`
          );
        }

        if (stableCount >= stableLimit) {
          logger.info(`Stopping scroll - no new connections found for ${stableLimit} attempts`);
          break;
        }

        await this._paced(800, 1500, () => page.mouse.wheel({ deltaY: 1000 }));
      } catch (err) {
        const error = err as Error;
        logger.warn(`Error during scroll ${i + 1}:`, error.message);
        break;
      }
    }

    logger.info(`Scroll completed. Final connection count: ${previousConnectionCount}`);
    return previousConnectionCount;
  }

  /**
   * Generic method to get connections from LinkedIn
   */
  async getConnections(options: GetConnectionsOptions = {}): Promise<string[]> {
    const { connectionType = 'ally', maxScrolls = 5 } = options;

    try {
      logger.info(`Getting ${connectionType} connections`, {
        connectionType,
        maxScrolls,
      });

      let targetUrl: string;
      switch (connectionType) {
        case 'ally':
          targetUrl = `${config.linkedin.baseUrl}/mynetwork/invite-connect/connections/`;
          break;
        case 'incoming':
          targetUrl = `${config.linkedin.baseUrl}/mynetwork/invitation-manager/received/`;
          break;
        case 'outgoing':
          targetUrl = `${config.linkedin.baseUrl}/mynetwork/invitation-manager/sent/`;
          break;
        default:
          throw new Error(`Unknown connection type: ${connectionType}`);
      }

      await this.puppeteer.goto(targetUrl);
      await this.puppeteer.waitForSelector('body', { timeout: 10000 });

      await this.scrollToLoadConnections(connectionType, maxScrolls);

      const profileIds = await this.puppeteer.extractLinks();

      logger.info(`Extracted ${profileIds.length} ${connectionType} connections`);

      if (profileIds.length > 0) {
        const sampleIds = profileIds.slice(0, 3).map((id) => id.substring(0, 5) + '...');
        logger.debug(`Sample profile IDs: ${sampleIds.join(', ')}`);
      }

      return profileIds;
    } catch (error) {
      logger.error(`Failed to get ${connectionType} connections:`, error);
      throw error;
    }
  }
}

export default LinkedInService;
