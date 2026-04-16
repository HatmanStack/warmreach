import { config } from '#shared-config/index.js';
import { logger } from '#utils/logger.js';
import {
  initializeLinkedInServices,
  cleanupLinkedInServices,
} from '../../../shared/utils/serviceFactory.js';
import { FileHelpers } from '#utils/fileHelpers.js';
import { SearchRequestValidator } from '../utils/searchRequestValidator.js';
import { SearchStateManager } from '../utils/searchStateManager.js';
import { LinkCollector } from '../../linkedin/utils/linkCollector.js';
import { ContactProcessor } from '../../linkedin/utils/contactProcessor.js';
import { HealingManager } from '../../automation/utils/healingManager.js';
import fs from 'fs/promises';

export class SearchController {
  async performSearch(req: any, res: any, opts: Record<string, any> = {}) {
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
      return res.status(401).json({
        error: 'Missing or invalid Authorization header',
      });
    }

    logger.info('Validating request with SearchRequestValidator...');
    const validationResult = SearchRequestValidator.validateRequest(req.body, jwtToken);
    logger.info(`Validation result: ${validationResult.isValid ? 'VALID' : 'INVALID'}`);
    if (!validationResult.isValid) {
      return res.status(validationResult.statusCode).json({
        error: validationResult.error,
        message: validationResult.message,
      });
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
      const result = await this.performSearchFromState(state);

      if (result === undefined) {
        return res.status(202).json({
          status: 'healing',
          message: 'Worker process started for healing/recovery.',
        });
      }

      res.json(this._buildSuccessResponse(result, { companyName, companyRole, companyLocation }));
    } catch (e) {
      logger.error('Search failed:', e);
      res.status(500).json(this._buildErrorResponse(e));
    }
  }

  async performSearchFromState(state: Record<string, any>) {
    const services = await this._initializeServices();
    let searchData: Record<string, any> = {};

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
        state,
        searchData.pictureUrls || {}
      );

      // @ts-expect-error -- searchData.uniqueLinks populated above
      return this._buildSearchResult(goodContacts, searchData.uniqueLinks || []);
    } catch (error: unknown) {
      logger.error('Search failed:', error);
      throw error;
    } finally {
      await this._cleanupServices(services);
    }
  }

  async _initializeServices() {
    return await initializeLinkedInServices();
  }

  async _performLogin(linkedInService: any, state: Record<string, any>) {
    logger.info('Logging in...');
    await linkedInService.login(
      state.searchName,
      state.searchPassword,
      state.lastPartialLinksFile,
      state.credentialsCiphertext,
      'search-controller'
    );
    logger.info('Login success.');

    if (state.healPhase) {
      logger.info(`Heal Phase: ${state.healPhase}\nReason: ${state.healReason}`);
    }
  }

  async _extractCompanyData(linkedInService: any, state: Record<string, any>) {
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
    }

    return { extractedCompanyNumber, extractedGeoNumber };
  }

  async _collectLinks(linkedInService: any, state: Record<string, any>, companyData: any) {
    const linkCollector = new LinkCollector(linkedInService, config);

    if (state.healPhase === 'link-collection') {
      const allLinks = await this._loadLinksFromFile(config.paths.linksFile);
      return { uniqueLinks: [...new Set(allLinks)], pictureUrls: {} };
    }

    const result = await linkCollector.collectAllLinks(
      state as any,
      companyData,
      (pageNumber: number) => this._handleLinkCollectionHealing(state, companyData, pageNumber)
    );

    const { links: allLinks, pictureUrls } = result;

    const uniqueLinks = [...new Set(allLinks)];
    await FileHelpers.writeJSON(config.paths.linksFile, uniqueLinks);

    return { uniqueLinks, pictureUrls: pictureUrls || {} };
  }

  async _processContacts(
    services: any,
    uniqueLinks: any[],
    state: Record<string, any>,
    pictureUrls: Record<string, any> = {}
  ) {
    const contactProcessor = new ContactProcessor(
      services.linkedInService,
      services.dynamoDBService,
      config as any,
      null
    );

    logger.info(
      `Loaded ${uniqueLinks.length} unique links to process. Starting at index: ${state.resumeIndex}`
    );

    return await contactProcessor.processAllContacts(
      uniqueLinks,
      state as any,
      (restartParams) => this._handleContactProcessingHealing(restartParams),
      pictureUrls
    );
  }

  async _handleLinkCollectionHealing(
    state: Record<string, any>,
    companyData: any,
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

  async _handleContactProcessingHealing(restartParams: Record<string, any>) {
    logger.warn(`All retry links failed. Initiating self-healing restart.`);
    logger.info('Restarting with fresh Puppeteer instance...');

    await this._initiateHealing({
      ...restartParams,
      healPhase: 'profile-parsing',
      healReason: 'Links failed',
    });
  }

  async _initiateHealing(healingParams: Record<string, any>) {
    const healingManager = new HealingManager();
    await healingManager.healAndRestart(healingParams);
  }

  async _loadLinksFromFile(filePath: string) {
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(fileContent);
    } catch (error: unknown) {
      if ((error as any).code === 'ENOENT') {
        // File not found is expected on first run or after cache clear - not an error
        logger.debug(`Links file not found at ${filePath}, starting fresh`);
        return [];
      }
      // For other errors (permissions, corrupted JSON), log but continue with empty array.
      // This allows the search to proceed rather than failing completely.
      // The links will be re-collected from LinkedIn.
      logger.error(`Failed to load links from ${filePath}:`, (error as Error).message);
      return [];
    }
  }

  async _cleanupServices(services: any): Promise<void> {
    logger.info('In finally, closing browser:', !!services?.puppeteerService);
    await cleanupLinkedInServices(services);
    logger.info('Closed browser in finally!');
  }

  _logRequestDetails(req: any): void {
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

  _extractJwtToken(req: any): string | undefined {
    const authHeader = req.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  }

  _buildSuccessResponse(
    result: any,
    searchParameters: Record<string, any>
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

  _buildErrorResponse(error: any): Record<string, unknown> {
    return {
      error: 'Internal server error during search',
      message: (error as Error).message,
      details: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined,
    };
  }

  _buildSearchResult(goodContacts: any[], uniqueLinks: any[]): Record<string, unknown> {
    return {
      goodContacts,
      uniqueLinks,
      stats: {
        successRate: ((goodContacts.length / uniqueLinks.length) * 100).toFixed(2) + '%',
      },
    };
  }

  // Legacy method for backward compatibility
  async healAndRestart(params: Record<string, any>) {
    const healingManager = new HealingManager();
    await healingManager.healAndRestart(params);
  }

  /**
   * Transport-agnostic search method for WebSocket command dispatch.
   * Calls the service layer directly instead of simulating an HTTP request.
   * @param {object} payload - { companyName, companyRole, companyLocation, jwtToken, ... }
   * @param {function} onProgress - (step, total, message) callback
   * @returns {Promise<object>} - { results, count }
   */
  async performSearchDirect(
    payload: Record<string, any>,
    onProgress: (...args: unknown[]) => void
  ) {
    let jwtToken = payload.jwtToken;

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

    const validationResult = SearchRequestValidator.validateRequest(payload, jwtToken) as any;
    if (!validationResult.isValid) {
      const err: Error & { code?: string } = new Error(
        validationResult.error || validationResult.message
      );
      err.code = 'SEARCH_ERROR';
      throw err;
    }

    const { companyName, companyRole, companyLocation, linkedinCredentialsCiphertext } = payload;

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

    const result = await this.performSearchFromState(state);

    if (result === undefined) {
      return {
        statusCode: 202,
        status: 'healing',
        message: 'Worker process started for healing/recovery.',
      };
    }

    return {
      statusCode: 200,
      ...this._buildSuccessResponse(result, { companyName, companyRole, companyLocation }),
    };
  }
}
