import puppeteer from 'puppeteer';
import type {
  Browser,
  Page,
  HTTPResponse,
  ElementHandle,
  ScreenshotOptions,
  WaitForSelectorOptions,
  GoToOptions,
  ClickOptions,
} from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { config } from '#shared-config/index.js';
import { logger } from '#utils/logger.js';
import { linkedinSelectors } from '../../linkedin/selectors/index.js';
import { RandomHelpers } from '#utils/randomHelpers.js';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
  getHeadlessEvasionScript,
} from '../utils/stealthScripts.js';
import {
  loadOrCreateProfile,
  GPU_PROFILES,
  type FingerprintProfile,
} from '../utils/fingerprintProfile.js';
import { responseTimingInterceptor } from '../utils/responseTimingInterceptor.js';

// The puppeteer-extra-plugin-stealth library triggers advanced LinkedIn EvalError logouts.
// We manage our own headless evasion natively via getHeadlessEvasionScript().

/**
 * Detect a system-installed Chrome/Chromium binary.
 * Returns the first path found, or undefined to use bundled Chromium.
 */
function detectSystemChrome(): string | undefined {
  const configPath = config.puppeteer.executablePath;
  if (configPath) return configPath;

  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // permission error etc — skip
    }
  }
  return undefined;
}

/**
 * Options for link extraction
 */
interface ExtractLinksOptions {
  timeoutMs?: number;
  autoScroll?: boolean;
  maxScrolls?: number;
  stableLimit?: number;
}

/**
 * Puppeteer service for browser automation.
 * Manages browser lifecycle and provides helper methods for common operations.
 */
export class PuppeteerService {
  private browser: Browser | null;
  private page: Page | null;
  private _requestHandler: ((req: any) => void) | null = null;
  private _consoleHandler: ((msg: any) => void) | null = null;
  private _pageerrorHandler: ((err: unknown) => void) | null = null;

  constructor() {
    this.browser = null;
    this.page = null;
  }

  async initialize(): Promise<Page> {
    try {
      const resolvedHeadless = !!config.puppeteer.headless;
      const displayEnv = process.env.DISPLAY || '';
      const sessionType = process.env.XDG_SESSION_TYPE || '';
      logger.info(
        `Initializing Puppeteer browser... HEADLESS env = ${process.env.HEADLESS} resolved headless = ${resolvedHeadless} DISPLAY = ${displayEnv || 'unset'} session = ${sessionType || 'unknown'} `
      );

      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ];

      // Non-headless UI niceties
      if (!resolvedHeadless) {
        launchArgs.push('--start-maximized', '--window-size=1400,900');
        if (process.platform === 'linux' && sessionType.toLowerCase() === 'wayland') {
          launchArgs.push('--ozone-platform=wayland', '--enable-features=UseOzonePlatform');
        }
      }

      // If user asked for UI but no DISPLAY is available, warn and keep headless to avoid crash
      const effectiveHeadless: boolean | 'shell' =
        resolvedHeadless || !displayEnv ? 'shell' : false;
      if (!resolvedHeadless && !displayEnv) {
        logger.warn(
          'HEADLESS=false requested but DISPLAY is not set. Browser UI cannot be shown in this environment. Running headless instead.'
        );
      }

      // Resolve userDataDir for persistent profile
      let userDataDir: string | undefined;
      let profileDir: string | undefined;

      if (config.puppeteer.userDataDir) {
        userDataDir = config.puppeteer.userDataDir;
        profileDir = userDataDir;
      } else {
        try {
          // Use Electron's userData path if available
          const { app } = await import('electron');
          const baseDir = app.getPath('userData');
          userDataDir = path.join(baseDir, 'browser-profile');
          profileDir = baseDir;
        } catch {
          // Not running in Electron — ephemeral profile
        }
      }

      // Load or create fingerprint profile
      let profile: FingerprintProfile | null = null;
      if (profileDir) {
        try {
          profile = loadOrCreateProfile(profileDir);
          const rotatedAt = new Date(profile.rotatedAt);
          const daysOld = Math.floor((Date.now() - rotatedAt.getTime()) / (1000 * 60 * 60 * 24));
          logger.info(
            `[FingerprintProfile] Loaded profile (age: ${daysOld} days, rotation in ${profile.rotationIntervalDays - daysOld} days)`
          );
        } catch (err) {
          logger.error('Failed to load fingerprint profile, falling back to random:', err);
        }
      }

      const executablePath = detectSystemChrome();

      this.browser = await puppeteer.launch({
        headless: effectiveHeadless,
        slowMo: config.puppeteer.slowMo,
        defaultViewport: null,
        args: launchArgs,
        ignoreDefaultArgs: ['--enable-automation'],
        ...(userDataDir ? { userDataDir } : {}),
        ...(executablePath ? { executablePath } : {}),
      });

      this.page = await this.browser!.newPage();

      // Set viewport - use profile resolution in headless mode if available
      const viewportWidth =
        profile && effectiveHeadless !== false
          ? profile.screenResolution.width
          : config.puppeteer.viewport.width;
      const viewportHeight =
        profile && effectiveHeadless !== false
          ? profile.screenResolution.height
          : config.puppeteer.viewport.height;

      await this.page.setViewport({
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        isMobile: false,
      });

      // Set user agent from profile or random pool
      const ua = profile ? profile.userAgent : (RandomHelpers.getRandomUserAgent() ?? '');
      await this.page.setUserAgent(ua);

      // Set default timeout
      this.page.setDefaultTimeout(config.timeouts.default);

      // Request interception: block chrome-extension:// requests
      if (config.puppeteer.enableRequestInterception) {
        await this.page.setRequestInterception(true);
        this._requestHandler = (req) => {
          if (req.url().startsWith('chrome-extension://')) {
            req.abort('blockedbyclient');
          } else {
            req.continue();
          }
        };
        this.page.on('request', this._requestHandler);
      }

      // Capture page console logs and errors to debug LinkedIn logouts/crashes
      this._consoleHandler = (msg) => {
        const type = msg.type();
        const rawText = msg.text();

        const location = msg.location();

        if (
          rawText.includes('net::ERR_BLOCKED_BY_CLIENT.Inspector') ||
          (location && location.url && location.url.includes('chrome-extension://invalid'))
        ) {
          return;
        }

        if (type === 'error' || type === 'warn' || type === 'log') {
          logger.debug(`[PAGE_${type.toUpperCase()}] ${rawText} `);
        }
      };
      this.page.on('console', this._consoleHandler);

      this._pageerrorHandler = (err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`[PAGE_EXCEPTION] ${errorMessage} `);
      };
      this.page.on('pageerror', this._pageerrorHandler);

      // Custom headless evasion (always enabled to spoof platform fingerprints regardless of head)
      if (profile) {
        await this.page.evaluateOnNewDocument(
          getHeadlessEvasionScript({
            platform: profile.platform,
            language: profile.language,
            pluginCount: profile.pluginCount,
          })
        );
      } else {
        await this.page.evaluateOnNewDocument(getHeadlessEvasionScript());
      }

      // Fingerprint noise injection
      if (config.puppeteer.enableFingerprintNoise) {
        if (profile) {
          await this.page.evaluateOnNewDocument(getCanvasNoiseScript(profile.canvasNoiseSeed));
          await this.page.evaluateOnNewDocument(getWebGLSpoofScript(profile.gpuProfile));
          await this.page.evaluateOnNewDocument(getAudioNoiseScript(profile.audioNoiseSeed));
        } else {
          // Fallback to random behavior if no profile
          await this.page.evaluateOnNewDocument(
            getCanvasNoiseScript(Math.floor(Math.random() * 1000000))
          );
          const randomGpu = GPU_PROFILES[Math.floor(Math.random() * GPU_PROFILES.length)]!;
          await this.page.evaluateOnNewDocument(getWebGLSpoofScript(randomGpu));
          await this.page.evaluateOnNewDocument(
            getAudioNoiseScript(Math.floor(Math.random() * 1000000))
          );
        }
      }

      try {
        const { BrowserSessionManager } =
          await import('../../session/services/browserSessionManager.js');
        const signalDetector = BrowserSessionManager.getSignalDetector();
        if (this.page && signalDetector) {
          responseTimingInterceptor.attachToPage(this.page, signalDetector);
        }
      } catch {
        logger.debug('SignalDetector not available during Puppeteer initialization');
      }

      logger.info('Puppeteer browser initialized successfully');
      return this.page;
    } catch (error) {
      logger.error('Failed to initialize Puppeteer:', error);
      throw error;
    }
  }

  async goto(url: string, options: GoToOptions = {}): Promise<HTTPResponse | null> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      logger.debug(`Navigating to: ${url} `);
      const response = await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.timeouts.navigation,
        ...options,
      });

      // Add random delay to mimic human behavior
      await RandomHelpers.randomDelay(1000, 3000);

      return response;
    } catch (error) {
      logger.error(`Failed to navigate to ${url}: `, error);
      throw error;
    }
  }

  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions = {}
  ): Promise<ElementHandle | null> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      return await this.page.waitForSelector(selector, {
        timeout: 5000,
        ...options,
      });
    } catch {
      logger.warn(`Selector not found: ${selector} `);
      return null;
    }
  }

  async safeClick(selector: string, options: ClickOptions = {}): Promise<boolean> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      const element = await this.waitForSelector(selector);
      if (element) {
        // Mouse simulation: move cursor along a human-like path before clicking
        if (config.puppeteer.enableMouseSimulation) {
          const box = await element.boundingBox();
          if (box) {
            const viewport = config.puppeteer.viewport;
            const mousePath = RandomHelpers.generateMousePath(viewport, box) as Array<{
              x: number;
              y: number;
            }>;
            for (const point of mousePath) {
              await this.page.mouse.move(point.x, point.y, {
                steps: RandomHelpers.randomInRange(2, 4),
              });
              await RandomHelpers.randomDelay(10, 30);
            }
          }
        }

        await element.click(options);
        await RandomHelpers.randomDelay(500, 1500);
        return true;
      }
      return false;
    } catch (error) {
      logger.warn(`Failed to click selector: ${selector} `, error);
      return false;
    }
  }

  async safeType(
    selector: string,
    text: unknown,
    options: { delay?: number } = {}
  ): Promise<boolean> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      // Validate and normalize input text to avoid Puppeteer type errors
      if (text === null || text === undefined) {
        logger.warn(`safeType called with null / undefined text for selector: ${selector} `);
        return false;
      }

      let inputText: string;
      if (typeof text !== 'string') {
        try {
          inputText = String(text);
        } catch {
          logger.warn(`safeType could not convert non - string text for selector: ${selector} `);
          return false;
        }
      } else {
        inputText = text;
      }

      const element = await this.waitForSelector(selector);
      if (element) {
        await element.type(inputText, {
          delay: RandomHelpers.randomInRange(50, 150),
          ...options,
        });
        return true;
      }
      return false;
    } catch (error) {
      logger.warn(`Failed to type in selector: ${selector} `, error);
      return false;
    }
  }

  async screenshot(path: string, options: ScreenshotOptions = {}): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      await this.page.screenshot({
        path,
        fullPage: true,
        ...options,
      });
      logger.debug(`Screenshot saved: ${path} `);
    } catch (error) {
      logger.error(`Failed to take screenshot: ${path} `, error);
      throw error;
    }
  }

  async scrollPage(
    direction: 'up' | 'down' = 'down',
    distance: number | null = null
  ): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      await this.page.evaluate(
        (dist: number | null, dir: 'up' | 'down') => {
          const scrollDistance =
            dist !== null ? dist : dir === 'down' ? window.innerHeight : -window.innerHeight;
          window.scrollBy(0, scrollDistance);
        },
        distance,
        direction
      );

      await RandomHelpers.randomDelay(1000, 2000);
    } catch (error) {
      logger.error('Failed to scroll page:', error);
      throw error;
    }
  }

  async extractLinks(
    selector: string | null = null,
    options: ExtractLinksOptions = {}
  ): Promise<string[]> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      // Backward-compat: if a selector was provided, try to wait for it first
      const waitSelectors: string[] = [];
      if (typeof selector === 'string' && selector.trim().length > 0) {
        waitSelectors.push(selector.trim());
      }

      // Default selectors that usually exist on LinkedIn search/people pages
      const defaultSelectors = [
        'a[href*="/in/"]',
        'a[href^="/in/"]',
        '.reusable-search__result-container a[href]',
      ];

      const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 10000);
      const selectorsToTry = waitSelectors.length > 0 ? waitSelectors : defaultSelectors;

      // Wait for at least one relevant anchor to appear
      let anyFound = false;
      for (const sel of selectorsToTry) {
        try {
          await this.page.waitForSelector(sel, { timeout: timeoutMs });
          anyFound = true;
          break;
        } catch {
          // keep trying others
        }
      }

      if (!anyFound) {
        // As a last resort, give the DOM a brief moment and proceed
        logger.debug('extractLinks: No selectors found, waiting 1s...');
        await new Promise((res) => setTimeout(res, 1000));
      } else {
        logger.debug('extractLinks: Found matching selector');
      }

      // Optionally auto-scroll/load to trigger lazy-loaded results until saturation
      if (options.autoScroll) {
        const maxIterations = Math.max(1, Math.min(50, Number(options.maxScrolls) || 1000));
        const stableLimit = Math.max(1, Math.min(5, Number(options.stableLimit) || 2));
        let stableCount = 0;
        let lastHeight = await this.page.evaluate(() => document.body.scrollHeight || 0);
        let lastLinkCount = await this.page.evaluate(
          () => Array.from(document.querySelectorAll('a[href]')).length
        );

        for (let i = 0; i < maxIterations; i++) {
          try {
            const cascadeShowMore = linkedinSelectors['search:show-more'] || [];
            const showMoreSel = cascadeShowMore
              .filter((s) => !s.selector.includes('::-p-'))
              .map((s) => s.selector)
              .join(', ');

            const didClickShowMore = await this.page.evaluate((selString) => {
              function isVisible(el: Element | null): boolean {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              }

              if (!selString) return false;
              const candidates = selString.split(',');
              for (const sel of candidates) {
                const btn = document.querySelector(sel.trim()) as HTMLButtonElement | null;
                if (btn && isVisible(btn)) {
                  const text = (btn.textContent || '').toLowerCase();
                  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                  // We still do a partial text check just to be safe if it matched a generic button
                  if (
                    text.includes('show more') ||
                    aria.includes('show more') ||
                    sel.includes('show-more')
                  ) {
                    btn.click();
                    return true;
                  }
                }
              }
              return false;
            }, showMoreSel);

            if (!didClickShowMore) {
              await this.page.evaluate(() => {
                window.scrollBy(0, Math.floor(window.innerHeight * 0.95));
              });
            }

            await RandomHelpers.randomDelay(700, 1400);

            const [newHeight, newLinkCount] = (await this.page.evaluate(() => [
              document.body.scrollHeight || 0,
              Array.from(document.querySelectorAll('a[href]')).length,
            ])) as [number, number];

            const heightChanged = newHeight > lastHeight;
            const linksGrew = newLinkCount > lastLinkCount;
            if (!heightChanged && !linksGrew) {
              stableCount += 1;
            } else {
              stableCount = 0;
            }
            lastHeight = Math.max(lastHeight, newHeight);
            lastLinkCount = Math.max(lastLinkCount, newLinkCount);

            if (stableCount >= stableLimit) {
              break;
            }
          } catch {
            break;
          }
        }
      }

      const profileIds = await this.page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const ids = new Set<string>();
        const debugInfo: string[] = [];

        debugInfo.push(`Total anchors found: ${anchors.length} `);

        for (const a of anchors) {
          const rawHref = a.getAttribute('href') || '';
          if (!rawHref) continue;

          // Normalize to absolute URL for consistent parsing
          let href = rawHref;
          try {
            if (href.startsWith('/')) {
              href = new URL(href, window.location.origin).toString();
            } else if (!/^https?:\/\//i.test(href)) {
              // Skip non-http(s) links
              continue;
            }
          } catch {
            continue;
          }

          // Quick filter to LinkedIn domains (skip when on mock/localhost)
          const isLinkedIn = /linkedin\.com/i.test(href);
          const isSameOrigin = href.startsWith(window.location.origin);
          if (!isLinkedIn && !isSameOrigin) {
            continue;
          }

          debugInfo.push(`LinkedIn href: ${href} `);

          try {
            href = decodeURIComponent(href);
          } catch {
            // ignore decode errors
          }

          // Extract the first path segment after /in/
          const match = href.match(/\/in\/([^\/?#]+)/i);
          if (match && match[1]) {
            ids.add(match[1]);
            debugInfo.push(`Extracted ID: ${match[1]} `);
          }
        }

        return Array.from(ids);
      });

      logger.debug(`extractLinks result: ${profileIds.length} IDs found`);

      return profileIds;
    } catch (error) {
      logger.error('Failed to extract links:', error);
      return [];
    }
  }

  /**
   * Extract profile picture URLs from the current connections list page.
   * Returns a map of profileId -> pictureUrl.
   */
  async extractProfilePictures(): Promise<Record<string, string>> {
    try {
      if (!this.page) {
        logger.warn('extractProfilePictures: No page available');
        return {};
      }

      const pictureMap = await this.page.evaluate(() => {
        const result: Record<string, string> = {};
        const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));

        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const match = href.match(/\/in\/([^\/?#]+)/i);
          if (!match || !match[1]) continue;

          const profileId = match[1];
          if (result[profileId]) continue;

          // Walk up to the card container (typically a <li> or div with card-like role)
          let container: Element | null = a;
          for (let i = 0; i < 5 && container; i++) {
            container = container.parentElement;
            if (container?.tagName === 'LI' || container?.classList.contains('entity-result')) {
              break;
            }
          }
          if (!container) continue;

          const img = container.querySelector(
            'img[src*="media.licdn.com"]'
          ) as HTMLImageElement | null;
          if (img?.src) {
            result[profileId] = img.src;
          }
        }

        return result;
      });

      logger.debug(`extractProfilePictures: found ${Object.keys(pictureMap).length} picture URLs`);
      return pictureMap;
    } catch (error) {
      logger.error('Failed to extract profile pictures:', error);
      return {};
    }
  }

  async close(): Promise<void> {
    try {
      responseTimingInterceptor.detach();
      if (this.page) {
        if (this._requestHandler) this.page.off('request', this._requestHandler);
        if (this._consoleHandler) this.page.off('console', this._consoleHandler);
        if (this._pageerrorHandler) this.page.off('pageerror', this._pageerrorHandler);
        this._requestHandler = null;
        this._consoleHandler = null;
        this._pageerrorHandler = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        logger.info('Puppeteer browser closed');
      }
    } catch (error) {
      logger.error('Error closing browser:', error);
    }
  }

  getPage(): Page | null {
    return this.page;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }
}
