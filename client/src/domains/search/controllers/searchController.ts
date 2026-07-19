import type { Request, Response } from 'express';
import { config } from '#shared-config/index.js';
import { logger } from '#utils/logger.js';
import {
  initializeLinkedInServices,
  cleanupLinkedInServices,
  type LinkedInServices,
} from '../../../shared/utils/serviceFactory.js';
import type { LinkedInService } from '../../linkedin/services/linkedinService.js';
import { isNodeErrno } from '../../../shared/types/errors.js';
import { FileHelpers } from '#utils/fileHelpers.js';
import { SearchRequestValidator } from '../utils/searchRequestValidator.js';
import { SearchStateManager, type SearchState } from '../utils/searchStateManager.js';
import { LinkCollector } from '../../linkedin/utils/linkCollector.js';
import { ContactProcessor } from '../../linkedin/utils/contactProcessor.js';
import { LocalProfileScraper } from '../../linkedin/services/localProfileScraper.js';
import { HealingRequiredError } from '../../automation/utils/healingError.js';
import fs from 'fs/promises';

/**
 * Company identifiers extracted from a search request, used to scope link
 * collection. Either may be null when the corresponding filter is absent.
 */
interface CompanyData {
  extractedCompanyNumber: string | null;
  extractedGeoNumber: string | null;
}

/**
 * Links + profile-picture URLs collected for a search, populated either from a
 * fresh collection run or rehydrated from disk during a heal phase.
 */
interface SearchData {
  uniqueLinks: string[];
  pictureUrls: Record<string, string>;
}

/**
 * Final search result: the good contacts found, the full link set analyzed,
 * and summary stats.
 */
interface SearchResult {
  goodContacts: string[];
  uniqueLinks: string[];
  stats: { successRate: string };
}

// Cap on in-process healing resumes before a run is aborted with a real error
// (rather than silently looping or ending with partial results).
const MAX_HEALING_ATTEMPTS = 3;

export class SearchController {
  async performSearch(
    req: Request,
    res: Response,
    opts: Record<string, unknown> = {}
  ): Promise<void> {
    logger.info('=== SEARCH REQUEST RECEIVED ===');
    logger.info(`Request path: ${req.path}, method: ${req.method}`);

    // Sanitize headers to remove sensitive data before logging
    const sanitizedHeaders = { ...req.headers };
    ['authorization', 'Authorization', 'cookie', 'Cookie'].forEach((key) => {
      if (sanitizedHeaders[key]) {
        sanitizedHeaders[key] = '[REDACTED]';
      }
    });
    logger.info(`Headers: ${JSON.stringify(sanitizedHeaders)}`);
    logger.info(`Body keys: ${req.body ? Object.keys(req.body).join(', ') : 'no body'}`);

    this._logRequestDetails(req);

    let jwtToken = this._extractJwtToken(req);
    logger.info(`JWT token extracted: ${jwtToken ? 'YES' : 'NO'}`);

    // In development with explicit bypass flag, allow requests without JWT for testing
    // SECURITY: Requires both NODE_ENV=development AND explicit ALLOW_DEV_AUTH_BYPASS=true
    if (
      !jwtToken &&
      config.nodeEnv === 'development' &&
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
    ) {
      logger.warn(
        'No JWT token found, using development test token (ALLOW_DEV_AUTH_BYPASS enabled)'
      );
      jwtToken = 'development-test-token';
    }

    if (!jwtToken) {
      logger.error('JWT token missing after fallback, rejecting request');
      res.status(401).json({
        error: 'Missing or invalid Authorization header',
      });
      return;
    }

    logger.info('Validating request with SearchRequestValidator...');
    const validationResult = SearchRequestValidator.validateRequest(req.body, jwtToken);
    logger.info(`Validation result: ${validationResult.isValid ? 'VALID' : 'INVALID'}`);
    if (!validationResult.isValid) {
      res.status(validationResult.statusCode).json({
        error: validationResult.error,
        message: validationResult.message,
      });
      return;
    }

    const { companyName, companyRole, companyLocation, linkedinCredentialsCiphertext } = req.body;
    // SECURITY: Credentials are passed as encrypted ciphertext only.
    // Decryption happens just-in-time at login() to minimize plaintext exposure window.
    // searchName/searchPassword are null here; LinkedInService.login() decrypts from ciphertext.
    const searchName = null;
    const searchPassword = null;

    logger.info('Starting LinkedIn search request', {
      companyName,
      companyRole,
      companyLocation,
      username: searchName ? '[REDACTED]' : 'not provided',
    });

    const state = SearchStateManager.buildInitialState({
      companyName,
      companyRole,
      companyLocation,
      searchName,
      searchPassword,
      credentialsCiphertext: linkedinCredentialsCiphertext,
      jwtToken,
      ...opts,
    });

    if (!state.healPhase) {
      // Fresh run: clear link and good-contact caches to avoid stale data
      await FileHelpers.writeJSON(config.paths.linksFile, []);
      await FileHelpers.writeJSON(config.paths.goodConnectionsFile, []);
    }

    try {
      const result = await this.runSearchWithHealing(state);
      if (result === undefined) throw new Error('Search returned no result');
      res.json(this._buildSuccessResponse(result, { companyName, companyRole, companyLocation }));
    } catch (e) {
      logger.error('Search failed:', e);
      res.status(500).json(this._buildErrorResponse(e));
    }
  }

  /**
   * Runs a search and transparently resumes in-process when a phase requests
   * healing. Each attempt re-invokes performSearchFromState from the resume
   * state with a fresh browser (the prior attempt's `finally` closes its own).
   * Capped at MAX_HEALING_ATTEMPTS so a persistently-failing run ends with a
   * real error instead of the old silent worker-spawn no-op.
   */
  async runSearchWithHealing(state: SearchState): Promise<SearchResult | undefined> {
    let current = state;
    for (;;) {
      try {
        return await this.performSearchFromState(current);
      } catch (error: unknown) {
        if (!(error instanceof HealingRequiredError)) throw error;
        const next = error.healState as SearchState;
        const attempt = next.recursionCount || 0;
        if (attempt > MAX_HEALING_ATTEMPTS) {
          logger.error('[search] healing recursion cap reached — aborting run', {
            phase: 'search',
            recursionCount: attempt,
            healPhase: next.healPhase,
            healReason: next.healReason,
          });
          throw new Error(
            `Search healing exceeded ${MAX_HEALING_ATTEMPTS} attempts (last reason: ${next.healReason || 'unknown'})`
          );
        }
        logger.warn('[search] healing — resuming in-process', {
          phase: 'search',
          recursionCount: attempt,
          healPhase: next.healPhase,
          healReason: next.healReason,
          resumeIndex: next.resumeIndex,
        });
        current = next;
      }
    }
  }

  async performSearchFromState(state: SearchState): Promise<SearchResult | undefined> {
    const services = await this._initializeServices();
    let searchData: SearchData = { uniqueLinks: [], pictureUrls: {} };

    logger.info('[search] performSearch requested', {
      phase: 'search',
      companyName: state.companyName,
      companyRole: state.companyRole,
      companyLocation: state.companyLocation,
      healPhase: state.healPhase,
    });

    try {
      await this._performLogin(services.linkedInService, state);

      if (state.healPhase === 'profile-parsing') {
        searchData.uniqueLinks = await this._loadLinksFromFile(state.lastPartialLinksFile);
        searchData.pictureUrls = {};
      } else {
        const companyData = await this._extractCompanyData(services.linkedInService, state);
        searchData = await this._collectLinks(services.linkedInService, state, companyData);
      }

      const goodContacts = await this._processContacts(
        services,
        searchData.uniqueLinks || [],
        state
      );

      return this._buildSearchResult(goodContacts ?? [], searchData.uniqueLinks);
    } catch (error: unknown) {
      // A healing request is a resume signal, not a failure — let the
      // run-with-healing loop handle it without logging a scary "failed".
      if (error instanceof HealingRequiredError) throw error;
      logger.error('Search failed:', error);
      throw error;
    } finally {
      await this._cleanupServices(services);
    }
  }

  async _initializeServices(): Promise<LinkedInServices> {
    return await initializeLinkedInServices();
  }

  async _performLogin(linkedInService: LinkedInService, state: SearchState) {
    logger.info('Logging in...');
    await linkedInService.login(
      state.searchName,
      state.searchPassword,
      // login() treats this as a boolean "recursion" flag; a partial-links file
      // means we are resuming, so pass its presence as that flag (preserves the
      // prior truthiness behavior when this was an untyped pass-through).
      !!state.lastPartialLinksFile,
      state.credentialsCiphertext,
      'search-controller'
    );
    logger.info('Login success.');

    if (state.healPhase) {
      logger.info(`Heal Phase: ${state.healPhase}\nReason: ${state.healReason}`);
    }
  }

  async _extractCompanyData(
    linkedInService: LinkedInService,
    state: SearchState
  ): Promise<CompanyData> {
    let extractedCompanyNumber = state.extractedCompanyNumber;
    let extractedGeoNumber = state.extractedGeoNumber;

    if (!extractedCompanyNumber && state.companyName) {
      extractedCompanyNumber = await linkedInService.searchCompany(state.companyName);
      if (!extractedCompanyNumber) {
        throw new Error(`Company "${state.companyName}" not found.`);
      }
    }

    if (!extractedGeoNumber && state.companyLocation) {
      extractedGeoNumber = await linkedInService.applyLocationFilter(state.companyLocation);
      if (!extractedGeoNumber) {
        // Degrade-with-warning (not fail-loud): a requested location we can't
        // resolve to a geoUrn shouldn't abort the whole run — the company filter
        // still yields useful (if broader) results, and a transient LinkedIn
        // typeahead miss shouldn't fail the search. Surface it loudly and
        // proceed company-only; the resolved-filters log below records the null
        // geo so off-filter drift stays diagnosable.
        logger.warn(
          `[search] location "${state.companyLocation}" could not be resolved to a geo filter; ` +
            `proceeding with company-only results (location filter dropped)`,
          { phase: 'search', companyLocation: state.companyLocation }
        );
      }
    }

    // These two IDs build the people-search URL; if either is unexpectedly
    // null the results page will be generic/empty, so surface them explicitly.
    logger.info('[search] company/geo filters resolved', {
      phase: 'search',
      companyName: state.companyName,
      companyLocation: state.companyLocation,
      extractedCompanyNumber,
      extractedGeoNumber,
    });

    return { extractedCompanyNumber, extractedGeoNumber };
  }

  async _collectLinks(
    linkedInService: LinkedInService,
    state: SearchState,
    companyData: CompanyData
  ): Promise<SearchData> {
    const linkCollector = new LinkCollector(linkedInService, config);

    if (state.healPhase === 'link-collection') {
      const allLinks = await this._loadLinksFromFile(config.paths.linksFile);
      return { uniqueLinks: [...new Set(allLinks)], pictureUrls: {} };
    }

    const result = await linkCollector.collectAllLinks(state, companyData, (pageNumber: number) =>
      this._handleLinkCollectionHealing(state, companyData, pageNumber)
    );

    const { links: allLinks, pictureUrls } = result;

    const uniqueLinks = [...new Set(allLinks)];
    await FileHelpers.writeJSON(config.paths.linksFile, uniqueLinks);

    return { uniqueLinks, pictureUrls: pictureUrls || {} };
  }

  async _processContacts(
    services: LinkedInServices,
    uniqueLinks: string[],
    state: SearchState
  ): Promise<string[] | undefined> {
    // serviceFactory hands ContactProcessor its OWN DynamoDBService instance,
    // separate from the one LinkedInService authenticates internally during
    // analyzeContactActivity. Without setting the token on this instance, every
    // getProfileDetails / createProfileMetadata call for a good contact 401s —
    // so no name/headline is ever written and the connection renders as
    // "Unknown".
    services.dynamoDBService.setAuthToken(state.jwtToken);

    // Wire the local profile scraper off the persistent browser page (same
    // pattern as profile-init). With it null, good contacts are stored as bare
    // status edges with no scraped profile metadata, so names stay empty.
    const page = services.puppeteerService.getPage();
    const localProfileScraper = page ? new LocalProfileScraper(page) : null;
    if (!localProfileScraper) {
      logger.warn(
        'No active browser page for search; profile scraping disabled, names will be empty'
      );
    }

    const contactProcessor = new ContactProcessor(
      services.linkedInService,
      services.dynamoDBService,
      config,
      localProfileScraper
    );

    logger.info(
      `Loaded ${uniqueLinks.length} unique links to process. Starting at index: ${state.resumeIndex}`
    );

    return await contactProcessor.processAllContacts(uniqueLinks, state, (restartParams) =>
      this._handleContactProcessingHealing(restartParams)
    );
  }

  async _handleLinkCollectionHealing(
    state: SearchState,
    companyData: CompanyData,
    pageNumber: number
  ) {
    logger.warn(`Initiating self-healing restart.`);
    logger.info('Restarting with fresh Puppeteer instance..');

    const healReasonText = '3 blank pages in a row';
    await this._initiateHealing({
      ...state,
      ...companyData,
      resumeIndex: pageNumber - 3,
      recursionCount: state.recursionCount + 1,
      healPhase: 'link-collection',
      healReason: healReasonText,
    });
  }

  async _handleContactProcessingHealing(restartParams: Record<string, unknown>) {
    logger.warn(`All retry links failed. Initiating self-healing restart.`);
    logger.info('Restarting with fresh Puppeteer instance...');

    await this._initiateHealing({
      ...restartParams,
      healPhase: 'profile-parsing',
      healReason: 'Links failed',
    });
  }

  async _initiateHealing(healingParams: Record<string, unknown>): Promise<never> {
    // In-process healing: unwind the current attempt (its `finally` closes the
    // browser) so runSearchWithHealing can resume from this state.
    throw new HealingRequiredError(healingParams);
  }

  async _loadLinksFromFile(filePath: string | null): Promise<string[]> {
    if (!filePath) return [];
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(fileContent) as string[];
    } catch (error: unknown) {
      if (isNodeErrno(error) && error.code === 'ENOENT') {
        // File not found is expected on first run or after cache clear - not an error
        logger.debug(`Links file not found at ${filePath}, starting fresh`);
        return [];
      }
      // For other errors (permissions, corrupted JSON), log but continue with empty array.
      // This allows the search to proceed rather than failing completely.
      // The links will be re-collected from LinkedIn.
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load links from ${filePath}:`, message);
      return [];
    }
  }

  async _cleanupServices(services: Partial<LinkedInServices> | null): Promise<void> {
    logger.info('In finally, closing browser:', !!services?.puppeteerService);
    await cleanupLinkedInServices(services);
    logger.info('Closed browser in finally!');
  }

  _logRequestDetails(req: Request): void {
    // Sanitize headers to prevent credential leakage in logs
    const sanitizedHeaders = { ...req.headers };
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
    sensitiveHeaders.forEach((key) => {
      if (sanitizedHeaders[key]) sanitizedHeaders[key] = '[REDACTED]';
      if (sanitizedHeaders[key.toLowerCase()]) sanitizedHeaders[key.toLowerCase()] = '[REDACTED]';
    });

    logger.info('Request details:', {
      method: req.method,
      url: req.url,
      headers: sanitizedHeaders,
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body',
    });
  }

  _extractJwtToken(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  }

  _buildSuccessResponse(
    result: SearchResult,
    searchParameters: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      response: result.goodContacts,
      metadata: {
        totalProfilesAnalyzed: result.uniqueLinks?.length,
        goodContactsFound: result.goodContacts?.length,
        successRate: result.stats?.successRate,
        searchParameters,
      },
    };
  }

  _buildErrorResponse(error: unknown): Record<string, unknown> {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      error: 'Internal server error during search',
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    };
  }

  _buildSearchResult(goodContacts: string[], uniqueLinks: string[]): SearchResult {
    return {
      goodContacts,
      uniqueLinks,
      stats: {
        successRate:
          uniqueLinks.length === 0
            ? '0.00%'
            : ((goodContacts.length / uniqueLinks.length) * 100).toFixed(2) + '%',
      },
    };
  }

  /**
   * Transport-agnostic search method for WebSocket command dispatch.
   * Calls the service layer directly instead of simulating an HTTP request.
   * @param {object} payload - { companyName, companyRole, companyLocation, jwtToken, ... }
   * @param {function} onProgress - (step, total, message) callback
   * @returns {Promise<object>} - { results, count }
   */
  async performSearchDirect(
    payload: Record<string, unknown>,
    onProgress: (...args: unknown[]) => void
  ) {
    let jwtToken = typeof payload.jwtToken === 'string' ? payload.jwtToken : undefined;

    if (
      !jwtToken &&
      config.nodeEnv === 'development' &&
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
    ) {
      jwtToken = 'development-test-token';
    }

    if (!jwtToken) {
      const err: Error & { code?: string } = new Error('Missing or invalid Authorization header');
      err.code = 'SEARCH_ERROR';
      throw err;
    }

    const validationResult = SearchRequestValidator.validateRequest(payload, jwtToken);
    if (!validationResult.isValid) {
      const err: Error & { code?: string } = new Error(
        validationResult.error || validationResult.message
      );
      err.code = 'SEARCH_ERROR';
      throw err;
    }

    const { companyName, companyRole, companyLocation, linkedinCredentialsCiphertext } =
      payload as {
        companyName?: string;
        companyRole?: string;
        companyLocation?: string;
        linkedinCredentialsCiphertext?: string;
      };

    const state = SearchStateManager.buildInitialState({
      companyName,
      companyRole,
      companyLocation,
      searchName: null,
      searchPassword: null,
      credentialsCiphertext: linkedinCredentialsCiphertext,
      jwtToken,
      progressCallback: onProgress,
    });

    if (!state.healPhase) {
      await FileHelpers.writeJSON(config.paths.linksFile, []);
      await FileHelpers.writeJSON(config.paths.goodConnectionsFile, []);
    }

    const result = await this.runSearchWithHealing(state);
    if (result === undefined) throw new Error('Search returned no result');

    return {
      statusCode: 200,
      ...this._buildSuccessResponse(result, { companyName, companyRole, companyLocation }),
    };
  }
}
