import { config } from '#shared-config/index.js';
import { logger } from '#utils/logger.js';
import { RandomHelpers } from '#utils/randomHelpers.js';
import DynamoDBService from '../../storage/services/dynamoDBService.js';
import { decryptSealboxB64Tag } from '#utils/crypto.js';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';
import type { Page, ElementHandle } from 'puppeteer';
import { linkedinResolver, linkedinSelectors } from '../selectors/index.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';

/**
 * Connection type options
 */
export type ConnectionType = 'ally' | 'incoming' | 'outgoing';

/**
 * Options for getConnections method
 */
interface GetConnectionsOptions {
  connectionType?: ConnectionType;
  maxScrolls?: number;
}

/**
 * Result of contact analysis
 */
interface ContactAnalysisResult {
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

  constructor(
    puppeteerService: PuppeteerService,
    dynamoDBService: DynamoDBService = new DynamoDBService()
  ) {
    this.puppeteer = puppeteerService;
    this.dynamoDBService = dynamoDBService;
  }

  /**
   * Execute a callback after a random delay. The delay is integral to the
   * return path — removing it breaks the function.
   */
  private async _paced<T>(minMs: number, maxMs: number, fn: () => Promise<T>): Promise<T> {
    await RandomHelpers.randomDelay(minMs, maxMs);
    return await fn();
  }

  /**
   * Private helper to run content analysis and record metrics
   */
  private async _analyze(
    context: { expectedContent?: 'search-results' | 'profile'; action?: string } = {}
  ): Promise<void> {
    try {
      const page = this.puppeteer.getPage();
      const detector = BrowserSessionManager.getSignalDetector();
      const analyzer = BrowserSessionManager.getContentAnalyzer();

      if (page && detector && analyzer) {
        await analyzer.analyzePage(page, detector, context);
      }
    } catch (err) {
      logger.debug('Content analysis failed (non-blocking)', err);
    }
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

      // Determine the intended account up front (opportunistically). A headless
      // run may rely purely on a persisted session, so missing plaintext creds is
      // NOT fatal here — we only need the username to verify session ownership
      // below, and we validate properly before actually driving the form.
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

      // Session reuse: the browser runs on a persistent profile (userDataDir),
      // so a prior login's cookies survive across runs. Before driving the
      // anti-bot-prone password form, check whether we're already authenticated
      // — navigate to the feed and look for the logged-in shell. If it's there
      // AND the session belongs to the requested account, skip credential login
      // entirely. This is what lets a one-time headed login carry subsequent
      // headless runs.
      const existingPage = this.puppeteer.getPage();
      if (existingPage) {
        try {
          await this.puppeteer.goto(`${config.linkedin.baseUrl}/feed/`);
          await linkedinResolver.resolvePresentWithWait(existingPage, 'nav:homepage', {
            timeout: 8000,
          });
          const ownership = await this._sessionOwnerMatches(loginUsername);
          if (ownership === 'mismatch') {
            // The persistent profile holds a DIFFERENT account's session. Reusing
            // it would run every action under the wrong LinkedIn identity, so fall
            // through to a credential login for the requested account instead.
            logger.warn(
              'Existing LinkedIn session belongs to a different account; ignoring it and logging in with the requested credentials.'
            );
          } else {
            logger.info(
              `Existing LinkedIn session detected (ownership: ${ownership}); skipping credential login.`
            );
            await this._analyze({ action: 'login' });
            return true;
          }
        } catch {
          logger.info('No valid existing session; proceeding with credential login.');
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

      const page = this.puppeteer.getPage();
      if (!page) {
        throw new Error('Browser page not available');
      }

      // Fill username. Prefer the on-screen field (LinkedIn's login page renders
      // a hidden duplicate form), but fall back to the first DOM-present match if
      // nothing lays out in time — a slow/throttled render shouldn't abort the run.
      const usernameInput = await this._resolveLoginField(page, 'nav:login-username');
      await usernameInput.type(loginUsername);

      // Fill password
      const passwordInput = await this._resolveLoginField(page, 'nav:login-password');
      await passwordInput.type(loginPassword);

      // Click login button
      const loginButton = await this._resolveLoginField(page, 'nav:login-submit');
      await loginButton.click();

      if (recursion) {
        logger.warn(
          'Recursion detected: repeated login/redirect loop during authentication. If using 2FA, consider disabling it or enabling an automated 2FA bypass for this flow.'
        );
      }

      // Post-login: do a short readiness probe instead of long navigation waits

      const shortCapMs = Math.min(8000, config.timeouts?.navigation || 15000);
      const start = Date.now();
      try {
        await Promise.race([
          page.waitForFunction(() => document.readyState === 'complete', { timeout: shortCapMs }),
          linkedinResolver.resolveWithWait(page, 'nav:homepage', {
            timeout: shortCapMs / 2,
          }),
        ]);
      } catch (error) {
        // Intentionally swallowed: LinkedIn is an SPA that may not trigger traditional
        // navigation events. The subsequent waitForSelector() with configurable timeout
        // handles the actual login verification. This race is just an optimization.
        logger.debug('Post-login readiness probe failed (non-blocking):', error);
      }
      const spent = Date.now() - start;
      logger.debug(`Post-login readiness probe took ${spent}ms`);

      // After login, wait for the logged-in feed shell to confirm success and
      // to allow time for any 2FA/checkpoint. There is no dedicated `login`
      // timeout in config (getTimeoutConfig omits it), and the old code passed
      // 0 to the resolver — which made resolveWithWait bail on its first loop
      // iteration WITHOUT checking the DOM. Use a generous fixed wait and poll
      // for the (visible) feed nav, which renders a beat after the SPA settles.
      const loginWaitMs = (config.timeouts?.login as number | undefined) ?? 45000;
      try {
        // Presence (not visibility): the feed shell is confirmed loaded as soon
        // as primary-nav exists in the DOM. A visible-only check fails because
        // the element flickers without a layout box during LinkedIn's React
        // hydration (the recurring #418). resolvePresentWithWait re-polls.
        await linkedinResolver.resolvePresentWithWait(page, 'nav:homepage', {
          timeout: loginWaitMs,
        });
        logger.info(
          'Homepage element detected after login; security challenge (if any) likely resolved.'
        );
      } catch (e) {
        logger.error('Homepage selector did not appear within the login timeout.', e);
        throw e;
      }

      // Content analysis after login
      await this._analyze({ action: 'login' });

      // Remember which account now owns the persistent session, so a later run
      // for a different account doesn't silently reuse it (identity guard above).
      await this._recordSessionOwner(loginUsername);

      logger.info('Login process completed');
      return true;
    } catch (error) {
      // Capture page state on ANY login failure so we can see what
      // LinkedIn actually served (login form vs. checkpoint vs.
      // captcha vs. blank). Writes screenshot + HTML to
      // <userData>/logs/login-failures/<timestamp>.{png,html}.
      try {
        const page = this.puppeteer.getPage();
        if (page) {
          const fs = await import('fs');
          const pathMod = await import('path');
          const electronMod = (await import('electron').catch(() => null)) as {
            app?: { getPath?: (k: string) => string };
          } | null;
          const userData = electronMod?.app?.getPath?.('userData') || process.cwd();
          const dumpDir = pathMod.join(userData, 'logs', 'login-failures');
          fs.mkdirSync(dumpDir, { recursive: true });

          // Bound disk growth: keep only the most recent MAX_DUMPS failures
          // (2 files each). Stamps are ISO timestamps, so a lexicographic
          // sort is chronological — oldest first. Best-effort; never let
          // pruning derail the actual dump.
          const MAX_DUMPS = 20;
          const existing = (await fs.promises.readdir(dumpDir).catch(() => [] as string[]))
            .filter((f) => f.endsWith('.png') || f.endsWith('.html'))
            .sort();
          for (let i = 0; i < existing.length - MAX_DUMPS * 2; i++) {
            const staleFile = existing[i];
            if (!staleFile) continue;
            await fs.promises.unlink(pathMod.join(dumpDir, staleFile)).catch(() => {});
          }

          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const shotPath = pathMod.join(dumpDir, `${stamp}.png`);
          const htmlPath = pathMod.join(dumpDir, `${stamp}.html`);
          // Track whether the screenshot actually landed — the success log
          // below shouldn't advertise a path that was never written.
          let shotOk = true;
          await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {
            shotOk = false;
          });
          const html = await page.content().catch(() => '');
          await fs.promises.writeFile(htmlPath, html);
          const title = await page.title().catch(() => '');
          logger.error('Login failure — page dump captured', {
            currentUrl: page.url(),
            title,
            screenshot: shotOk ? shotPath : '(screenshot failed)',
            html: htmlPath,
          });
        }
      } catch (dumpErr) {
        logger.error('Failed to capture login-failure page dump', {
          error: (dumpErr as Error).message,
        });
      }
      logger.error('Login failed:', error);
      throw error;
    }
  }

  /**
   * Resolve a login form field, preferring the on-screen element (LinkedIn
   * renders a hidden duplicate login form). If nothing acquires a layout box
   * within the timeout — a slow/throttled render — fall back to the first
   * DOM-present match rather than aborting the entire run.
   */
  private async _resolveLoginField(page: Page, interactionPoint: string): Promise<ElementHandle> {
    try {
      return await linkedinResolver.resolveVisibleWithWait(page, interactionPoint, {
        timeout: 10000,
      });
    } catch (err) {
      logger.warn(
        `Login field ${interactionPoint} not visible within timeout; falling back to first DOM-present match`,
        { error: err instanceof Error ? err.message : String(err) }
      );
      return await linkedinResolver.resolveWithWait(page, interactionPoint, { timeout: 5000 });
    }
  }

  /**
   * The persistent browser-profile directory (mirrors puppeteerService): the
   * configured userDataDir, else Electron's userData base. Undefined when
   * running with an ephemeral profile (tests/dev without Electron).
   */
  private async _resolveProfileDir(): Promise<string | undefined> {
    if (config.puppeteer.userDataDir) return config.puppeteer.userDataDir;
    try {
      const { app } = await import('electron');
      return app.getPath('userData');
    } catch {
      return undefined;
    }
  }

  /** Path of the marker that records which account owns the persistent session. */
  private async _sessionOwnerMarkerPath(): Promise<string | undefined> {
    const dir = await this._resolveProfileDir();
    if (!dir) return undefined;
    const path = await import('path');
    return path.join(dir, '.warmreach-session-owner');
  }

  /** Stable, non-reversible fingerprint of an account identifier (never the raw email). */
  private async _hashUsername(username: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto
      .createHash('sha256')
      .update(username.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Whether the persistent session belongs to *username*. Returns 'unknown' when
   * ownership can't be determined (no username, no marker yet, ephemeral profile)
   * — callers treat 'unknown' as "reuse allowed" to preserve the legacy one-time-
   * login flow; only a definite 'mismatch' forces a fresh credential login.
   */
  private async _sessionOwnerMatches(
    username?: string | null
  ): Promise<'match' | 'mismatch' | 'unknown'> {
    if (!username || username.trim().length === 0) return 'unknown';
    try {
      const markerPath = await this._sessionOwnerMarkerPath();
      if (!markerPath) return 'unknown';
      const fs = await import('fs/promises');
      const stored = (await fs.readFile(markerPath, 'utf8').catch(() => '')).trim();
      if (!stored) return 'unknown';
      return stored === (await this._hashUsername(username)) ? 'match' : 'mismatch';
    } catch {
      return 'unknown';
    }
  }

  /** Persist the current session's owning account (best-effort). */
  private async _recordSessionOwner(username?: string | null): Promise<void> {
    if (!username || username.trim().length === 0) return;
    try {
      const markerPath = await this._sessionOwnerMarkerPath();
      if (!markerPath) return;
      const fs = await import('fs/promises');
      await fs.writeFile(markerPath, await this._hashUsername(username), 'utf8');
    } catch (err) {
      // Best-effort: if we can't persist, the identity guard degrades to
      // 'unknown' (reuse allowed) rather than breaking login.
      logger.debug('Could not record session owner marker', {
        error: err instanceof Error ? err.message : String(err),
      });
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
        // Capture the typeahead/suggestion DOM — the likely next 2026 break
        // point once the filter pill opens correctly.
        try {
          await this._dumpSearchHtml('company-suggestion-failure', await page.content());
        } catch {
          // best-effort
        }
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
      } catch (error) {
        logger.warn('Timed out waiting for company parameter in URL:', error);
      }

      // Analyze search results content
      await this._analyze({ expectedContent: 'search-results', action: 'search' });

      if (extractedCompanyNumber) {
        logger.info(`Extracted company number: ${extractedCompanyNumber}`);
      } else {
        logger.warn('Could not extract company ID from URL');
      }

      return extractedCompanyNumber;
    } catch (error) {
      logger.error(`Failed to extract Company ID for ${companyName}:`, error);
      // Capture the filter-panel DOM so the stale search:filter-button /
      // search:filter-input selectors can be repaired against the live 2026
      // markup. The company filter is where search currently dies.
      try {
        const page = this.puppeteer.getPage();
        if (page) await this._dumpSearchHtml('company-filter-failure', await page.content());
      } catch {
        // best-effort diagnostic; never mask the original error
      }
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
      } catch (error) {
        logger.warn('Timed out waiting for geoUrn parameter in URL:', error);
      }

      // Analyze search results content
      await this._analyze({ expectedContent: 'search-results', action: 'search' });

      if (extractedGeoNumber) {
        logger.info(`Extracted geo number: ${extractedGeoNumber}`);
      } else {
        logger.warn('Could not extract geo ID from URL');
      }

      return extractedGeoNumber;
    } catch (error) {
      logger.error('Failed to apply location filter:', error);
      // Capture the location filter DOM for selector repair (same rationale as
      // the company filter).
      try {
        const page = this.puppeteer.getPage();
        if (page) await this._dumpSearchHtml('location-filter-failure', await page.content());
      } catch {
        // best-effort diagnostic
      }
      throw error;
    }
  }

  private async _clickFilterButton(filterName: string): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    try {
      const button = await linkedinResolver.resolveWithWait(page, 'search:filter-button', {
        timeout: 5000,
        params: { filterName },
      });
      await button.click();
      logger.debug(`Clicked filter "${filterName}" with resolver`);
      return true;
    } catch (error) {
      logger.debug(`Filter selector failed for: ${filterName}`, error);
    }

    // Fallback: find by text content across buttons, labels, and 2026-style
    // `[role="button"]` pills. Crucially, click the nearest `[role="button"]`
    // ancestor when the text match lands on an inner `<label>`/`<span>` — the
    // label itself is not the clickable control in the 2026 DOM.
    try {
      const clicked = await page.evaluate((name: string) => {
        const needle = name.toLowerCase();
        const elements = Array.from(
          document.querySelectorAll('button, label, [role="button"], [aria-label]')
        );
        const match = elements.find((el) => {
          const text = el.textContent?.trim().toLowerCase() ?? '';
          const aria = el.getAttribute('aria-label')?.toLowerCase() ?? '';
          return text.includes(needle) || aria.includes(needle);
        });
        if (match) {
          const target = (match.closest('[role="button"]') as HTMLElement | null) ?? match;
          (target as HTMLElement).click();
          return true;
        }
        return false;
      }, filterName);
      if (clicked) {
        logger.debug(`Clicked filter "${filterName}" via text content fallback`);
        return true;
      }
    } catch (error) {
      logger.debug(`Filter text-content fallback failed for "${filterName}":`, error);
    }

    logger.warn(`Could not find filter: ${filterName}`);
    return false;
  }

  private async _typeInFilterInput(text: string): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    try {
      // Budget enough overall time for the resolver to fall through to later
      // strategies — each cascade strategy can wait up to ~2s, and a too-small
      // overall timeout means only the first strategy is ever attempted.
      const element = await linkedinResolver.resolveWithWait(page, 'search:filter-input', {
        timeout: 8000,
      });
      await element.click({ count: 3 });
      await page.keyboard.press('Backspace');
      await element.type(text, { delay: 50 });
      logger.debug(`Typed "${text}" in filter input with resolver`);
      return true;
    } catch (error) {
      logger.debug('Filter input selector failed:', error);
    }

    logger.warn('Could not find filter input field');
    return false;
  }

  private async _selectFilterSuggestion(searchText: string): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    try {
      // Larger budget so the resolver reaches later cascade strategies (each
      // waits up to ~2s); a tight timeout only ever tries the first couple.
      await linkedinResolver.resolveWithWait(page, 'search:filter-suggestions', { timeout: 8000 });
    } catch (error) {
      logger.debug('Suggestion selector failed to find items:', error);
      return false;
    }

    const cascade = linkedinSelectors['search:filter-suggestions'] || [];
    for (const strat of cascade) {
      const selector = strat.selector;
      if (selector.includes('::-p-')) continue;

      try {
        const clicked = await page.evaluate(
          (sel: string, text: string) => {
            const items = Array.from(document.querySelectorAll(sel));
            if (items.length === 0) return false;

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
          logger.debug(`Selected suggestion for "${searchText}" with strategy: ${strat.strategy}`);
          return true;
        }
      } catch (error) {
        logger.debug(`Suggestion strategy "${strat.strategy}" failed for "${searchText}":`, error);
      }
    }

    logger.warn(`No suggestions found for: ${searchText}`);
    return false;
  }

  private async _clickShowResults(): Promise<boolean> {
    const page = this.puppeteer.getPage();
    if (!page) return false;

    try {
      const button = await linkedinResolver.resolveWithWait(page, 'search:apply-filter', {
        timeout: 3000,
      });
      await button.click();
      logger.debug(`Clicked "Show results" with resolver`);
      return true;
    } catch (error) {
      logger.debug('Show-results resolver failed, trying fallback:', error);
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
    } catch (error) {
      logger.debug('Show-results text-content fallback failed:', error);
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
      const page = this.puppeteer.getPage();
      if (!page) throw new Error('Page missing');

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

      logger.info('[search] fetching people page', {
        phase: 'search',
        pageNumber,
        url,
        hasCompanyFilter: !!extractedCompanyNumber,
        hasGeoFilter: !!extractedGeoNumber,
        hasRoleKeyword: !!encodedRole,
      });

      await this.puppeteer.goto(url);

      // Analyze search results content
      await this._analyze({ expectedContent: 'search-results', action: 'search' });

      // Where did we actually land? A redirect to login/checkpoint/authwall is
      // the most common reason a "results" page is empty.
      const landedUrl = page.url();
      let pageTitle = '';
      try {
        pageTitle = await page.title();
      } catch {
        // ignore — title is best-effort diagnostic
      }
      const onAuthWall = /\/(login|checkpoint|authwall|uas\/login)/i.test(landedUrl);
      logger.info('[search] people page loaded', {
        phase: 'search',
        pageNumber,
        landedUrl,
        pageTitle,
        onAuthWall,
        reachedResults: landedUrl.includes('/search/results/people'),
      });

      // Wait for content to load
      let hasContent = false;
      try {
        await linkedinResolver.resolveWithWait(page, 'search:result-items', { timeout: 5000 });
        hasContent = true;
      } catch (error) {
        logger.warn('[search] result-items selector did not resolve', {
          phase: 'search',
          pageNumber,
          landedUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Scope to genuine result cards — NOT a whole-page `a[href*="/in/"]` sweep,
      // which also grabs "People you may know" / "People also viewed" profiles
      // that ignore the company/geo filter (wrong-company results).
      const links = hasContent ? await this._extractSearchResultLinks() : [];
      logger.info('[search] extracted profile links', {
        phase: 'search',
        pageNumber,
        hasContent,
        linkCount: links.length,
        sample: links.slice(0, 5),
      });

      // Never let an empty page go undiagnosed: capture the raw HTML whenever a
      // page yields no links (or always, when SEARCH_DUMP_HTML is on) so the
      // 2026 search DOM can be inspected offline.
      if (!hasContent || links.length === 0 || config.linkedin.searchDumpHtml) {
        try {
          const html = await page.content();
          await this._dumpSearchHtml(`people-page-${pageNumber}`, html);
        } catch (dumpErr) {
          logger.debug('[search] could not capture page HTML for dump', dumpErr);
        }
      }

      if (!hasContent) {
        logger.warn('[search] no result content on page', {
          phase: 'search',
          pageNumber,
          landedUrl,
          pageTitle,
          onAuthWall,
        });
        return { links: [], pictureUrls: {} };
      }

      // Extract profile picture URLs from the same page (no extra navigation)
      let pictureUrls: Record<string, string> = {};
      try {
        pictureUrls = await this.puppeteer.extractProfilePictures();
      } catch (error) {
        logger.debug('Profile picture extraction failed (non-fatal):', error);
      }

      return { links, pictureUrls };
    } catch (error) {
      // Return empty result instead of throwing to allow pagination to continue.
      logger.error(`Failed to get links from page ${pageNumber}:`, error);
      return { links: [], pictureUrls: {} };
    }
  }

  /**
   * Persist a search results page's raw HTML to <userData>/logs/search-dumps
   * for offline selector analysis (mirrors the profile scraper's dump). Called
   * automatically for empty pages so the 2026 search DOM is never a black box.
   * Best-effort, capped, never throws.
   */
  /**
   * Collect profile links from the CURRENT people-search results page, scoped to
   * genuine result cards.
   *
   * LinkedIn injects "People you may know" / "People also viewed" recommendation
   * modules into the same results page. Those recommendations are NOT subject to
   * the company / geo / keyword filter, so a blind `a[href*="/in/"]` sweep of the
   * whole page pulls in people from the wrong companies (the "searched Apple, got
   * Amazon" bug). We only take links from top-level result list-items that
   * reference a single person and are not inside a labelled recommendation
   * section:
   *  - a genuine result card links to exactly one person (avatar + name → 1 id);
   *  - a recommendation carousel is one list-item linking to many people (>2 ids);
   *  - recommendation sections carry a heading like "People you may know".
   */
  private async _extractSearchResultLinks(): Promise<string[]> {
    const page = this.puppeteer.getPage();
    if (!page) return [];
    const { links, skippedReco, resultCards, recoOverMatch, usedAnchorFallback } =
      await page.evaluate(() => {
        const RECO =
          /people you may know|people also viewed|more profiles|similar profiles|you might know|suggested|recommended for you/i;
        // The PRIMARY (first) /in/ link in a result card is the person the card is
        // about; any later /in/ links are secondary (mutual connections) and must
        // be ignored — collecting them pulls in people who don't match the filter.
        const firstProfileId = (node: Element): string | null => {
          for (const a of Array.from(node.querySelectorAll('a[href*="/in/"]'))) {
            const m = (a.getAttribute('href') || '').match(/\/in\/([^/?#]+)/i);
            if (m && m[1]) {
              try {
                return decodeURIComponent(m[1]);
              } catch {
                return m[1];
              }
            }
          }
          return null;
        };
        const isHeading = (n: Element): boolean =>
          /^H[1-4]$/.test(n.tagName) || n.getAttribute('role') === 'heading';
        // A card is a recommendation only when one of its ancestor containers is
        // LABELLED as reco by its OWN header — a heading in that container's
        // shallow header region (a direct child, or a heading one level inside a
        // direct-child header wrapper). We must NOT scan each ancestor's full
        // subtree: the results list and the "People you may know" module usually
        // share a common ancestor (main/content) within a few levels, so a subtree
        // scan would find the reco heading from every genuine result card and skip
        // the entire page — search would silently return nothing.
        const recoHeaderHere = (el: Element): boolean => {
          for (const child of Array.from(el.children)) {
            if (isHeading(child)) {
              if (RECO.test(child.textContent || '')) return true;
            } else {
              for (const g of Array.from(child.children)) {
                if (isHeading(g) && RECO.test(g.textContent || '')) return true;
              }
            }
          }
          return false;
        };
        const inRecoSection = (el0: Element): boolean => {
          for (let el: Element | null = el0, d = 0; el && d < 8; d++, el = el.parentElement) {
            if (recoHeaderHere(el)) return true;
          }
          return false;
        };
        // 2026 people-search results are top-level `<div role="listitem">` cards
        // (one person each) inside a single `role="list"` — NOT `<li>`. Fall back
        // to top-level `<li>` for older layouts.
        let cards = Array.from(document.querySelectorAll('[role="listitem"]')).filter(
          (el) => !el.parentElement || !el.parentElement.closest('[role="listitem"]')
        );
        if (cards.length === 0) {
          cards = Array.from(document.querySelectorAll('li')).filter(
            (li) => !li.parentElement || !li.parentElement.closest('li')
          );
        }
        const out: string[] = [];
        const seen = new Set<string>();
        const add = (id: string | null): void => {
          if (id && !seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        };
        let skippedReco = 0;
        for (const card of cards) {
          if (inRecoSection(card)) {
            skippedReco++;
            continue;
          }
          add(firstProfileId(card));
        }
        // Fail-open safety net: if EVERY card was classified as a recommendation,
        // the heuristic has almost certainly over-matched (a relabelled DOM, or a
        // reco module the header scan still caught) rather than the page genuinely
        // being all recommendations. Returning [] here would silently make search
        // find nothing, so recover the first link per card and flag the anomaly.
        let recoOverMatch = false;
        if (out.length === 0 && cards.length > 0 && skippedReco === cards.length) {
          recoOverMatch = true;
          for (const card of cards) add(firstProfileId(card));
        }
        // Last-resort fallback: neither selector matched any structured card (a
        // DOM redesign). Rather than yield nothing, sweep profile anchors that are
        // not inside a labelled reco section so real results are still collected.
        let usedAnchorFallback = false;
        if (cards.length === 0) {
          usedAnchorFallback = true;
          for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]'))) {
            if (inRecoSection(a)) {
              skippedReco++;
              continue;
            }
            const m = (a.getAttribute('href') || '').match(/\/in\/([^/?#]+)/i);
            if (!m || !m[1]) continue;
            let id: string;
            try {
              id = decodeURIComponent(m[1]);
            } catch {
              id = m[1];
            }
            add(id);
          }
        }
        return {
          links: out,
          skippedReco,
          resultCards: cards.length,
          recoOverMatch,
          usedAnchorFallback,
        };
      });
    logger.info('[search] scoped result-link extraction', {
      phase: 'search',
      kept: links.length,
      skippedRecommendationCards: skippedReco,
      resultCards,
      recoOverMatch,
      usedAnchorFallback,
    });
    if (recoOverMatch) {
      logger.warn(
        '[search] recommendation filter matched every result card; failed open to avoid an empty page',
        { phase: 'search', resultCards, recovered: links.length }
      );
    }
    if (usedAnchorFallback) {
      logger.warn('[search] no structured result cards found; used anchor-sweep fallback', {
        phase: 'search',
        recovered: links.length,
      });
    }
    return links;
  }

  private async _dumpSearchHtml(label: string, html: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      let userData = process.cwd();
      try {
        const { createRequire } = await import('module');
        const require_ = createRequire(import.meta.url);
        const electron = require_('electron') as { app?: { getPath?: (k: string) => string } };
        userData = electron?.app?.getPath?.('userData') || userData;
      } catch {
        // Not in Electron (tests/dev) — fall back to cwd.
      }
      const dir = path.join(userData, 'logs', 'search-dumps');
      await fs.mkdir(dir, { recursive: true });

      // Search pages are ~0.3–0.5 MB each; keep only the most recent handful
      // PER CATEGORY. Retaining a flat last-N total let the many per-profile
      // `activity-*` dumps evict the (few, more valuable) `people-page-*` dumps
      // before they could be inspected.
      const KEEP_PER_CATEGORY = 6;
      const labelOf = (fname: string): string => {
        const base = fname.replace(/\.html$/, '');
        const idx = base.indexOf('Z-');
        return idx >= 0 ? base.slice(idx + 2) : base;
      };
      const categoryOf = (lbl: string): string =>
        lbl.startsWith('activity-') ? 'activity' : lbl.replace(/-\d+$/, '');
      const existing = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) =>
        f.endsWith('.html')
      );
      const byCategory = new Map<string, string[]>();
      for (const f of existing) {
        const cat = categoryOf(labelOf(f));
        (byCategory.get(cat) ?? byCategory.set(cat, []).get(cat)!).push(f);
      }
      for (const files of byCategory.values()) {
        files.sort();
        for (let i = 0; i < files.length - KEEP_PER_CATEGORY; i++) {
          const stale = files[i];
          if (stale) await fs.unlink(path.join(dir, stale)).catch(() => {});
        }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${label}.html`);
      await fs.writeFile(file, html);
      logger.info('[search] dumped search results HTML for selector analysis', {
        phase: 'search',
        label,
        file,
        bytes: html.length,
      });
    } catch (error) {
      logger.debug('[search] failed to dump search HTML (non-fatal)', error);
    }
  }

  async analyzeContactActivity(
    profileId: string,
    jwtToken: string,
    searchContext?: { company?: string; role?: string; location?: string }
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

      // Analyze profile content
      await this._analyze({ expectedContent: 'profile' });

      const currentUrl = page.url();

      // Detection of security challenges
      const pageContent = await page.content();
      if (currentUrl.includes('checkpoint') || /captcha|verify/i.test(pageContent)) {
        logger.warn('Checkpoint detected — pausing automation and notifying user');
        const controller = BrowserSessionManager.getBackoffController();
        if (controller) {
          await controller.handleCheckpoint(currentUrl);
        }
      }

      // Diagnostic (dump-flag only): the viability score depends entirely on
      // finding recent-activity timestamps. If the selector or the timestamp
      // format drifted in the 2026 DOM, every contact scores 0 and no candidate
      // is ever "good". When SEARCH_DUMP_HTML is on, surface what the timestamp
      // selector matches AND any time-ago tokens present on the page in ANY
      // format, then dump the reactions page for offline inspection. Gated so it
      // adds no extra page.evaluate call on the normal (non-dump) path.
      if (config.linkedin.searchDumpHtml) {
        try {
          const probe = await page.evaluate(() => {
            const els = Array.from(
              document.querySelectorAll('span[aria-hidden="true"], p[componentkey]')
            );
            const texts = els
              .map((e) => (e.textContent || '').trim())
              .filter(Boolean)
              .slice(0, 12);
            const bodyText = (document.body as HTMLElement | null)?.innerText || '';
            const tokens = (
              bodyText.match(
                /\b\d+\s*(?:h|hr|hours?|d|days?|w|wk|weeks?|mo|months?|y|yr|years?)\b(?:\s*ago)?/gi
              ) || []
            ).slice(0, 12);
            return { matched: els.length, texts, tokens, url: location.href };
          });
          logger.info('[activity] timestamp probe', {
            phase: 'activity',
            profileId,
            matchedElements: probe.matched,
            sampleTexts: probe.texts,
            timeTokensOnPage: probe.tokens,
            url: probe.url,
          });
          await this._dumpSearchHtml(`activity-${profileId}`, await page.content());
        } catch (probeErr) {
          logger.debug('[activity] timestamp probe failed', probeErr);
        }
      }

      let score = 0;
      const totalCounts: ActivityCounts = { hour: 0, day: 0, week: 0 };
      const { recencyHours, recencyDays, recencyWeeks, historyToCheck } = config.linkedin;
      logger.debug(
        `Recency settings - Hours: ${recencyHours}, Days: ${recencyDays}, Weeks: ${recencyWeeks}`
      );
      const countedSet = new Set<string>();

      for (let i = 0; i < historyToCheck; i++) {
        try {
          await linkedinResolver.resolveWithWait(page, 'profile:activity-time', { timeout: 5000 });
        } catch (error) {
          logger.debug(`Activity time selector not found on iteration ${i}:`, error);
        }

        const timeSelectors = (
          linkedinSelectors['profile:activity-time'] as Array<{
            strategy: string;
            selector: string;
          }>
        )
          .filter((s) => !s.selector.includes('::-p-'))
          .map((s) => s.selector)
          .join(', ');

        const result = await page.evaluate(
          (existingCounts: ActivityCounts, countedArr: string[], timeSel: string) => {
            // Match BOTH the 2026 long forms ("3 hours ago", "2 days ago") and
            // the legacy short forms ("3h", "2d", "1w"). Minutes are the
            // freshest activity, so fold them into the "hour" (most-recent)
            // tier. The word boundary after each unit keeps "mo"/"months" and
            // "yr"/"years" from ever counting as recent (LinkedIn shows those
            // once activity is stale), so only within-a-month activity scores.
            const timeframes: Record<string, RegExp> = {
              hour: /\b\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i,
              day: /\b[1-6]\s*(?:d|day|days)\b/i,
              week: /\b[1-4]\s*(?:w|wk|wks|week|weeks)\b/i,
            };
            const elements = Array.from(document.querySelectorAll(timeSel));
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
          Array.from(countedSet),
          timeSelectors
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
        // Record search provenance ("why surfaced") on the edge. The backend
        // preserves it across status transitions, so it survives to `ally` and
        // can equip first contact after the connection is accepted.
        const provenance: Record<string, string> = { source: 'search' };
        if (searchContext?.company) provenance.sourceCompany = searchContext.company;
        if (searchContext?.role) provenance.sourceRole = searchContext.role;
        if (searchContext?.location) provenance.sourceLocation = searchContext.location;
        await this.dynamoDBService.upsertEdgeStatus(profileId, 'possible', provenance);
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
        const cascade =
          (linkedinSelectors['search:profile-links'] as Array<{
            strategy: string;
            selector: string;
          }>) || [];
        const connectionSelectors = cascade
          .filter((s) => !s.selector.includes('::-p-'))
          .map((s) => s.selector)
          .join(', ');

        const currentConnectionCount = await page.evaluate((selString: string) => {
          let totalCount = 0;
          if (!selString) return 0;
          selString.split(',').forEach((selector) => {
            const elements = document.querySelectorAll(selector.trim());
            totalCount = Math.max(totalCount, elements.length);
          });

          return totalCount;
        }, connectionSelectors);

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

      let profileIds = await this.puppeteer.extractLinks();

      logger.info(`Extracted ${profileIds.length} ${connectionType} connections`);

      // Dev/testing cap: only ingest the first N per list when configured, so we
      // can validate profile-init end-to-end without pulling the entire network.
      const maxPerType = config.linkedin.maxConnectionsPerType;
      if (maxPerType > 0 && profileIds.length > maxPerType) {
        logger.info(
          `Capping ${connectionType} connections to ${maxPerType} of ${profileIds.length} (PROFILE_INIT_MAX_CONNECTIONS)`
        );
        profileIds = profileIds.slice(0, maxPerType);
      }

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
