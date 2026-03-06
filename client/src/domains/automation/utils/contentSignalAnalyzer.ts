import { Page } from 'puppeteer';
import { SignalDetector } from './signalDetector.js';
import { SelectorResolver } from './selectorResolver.js';
import { logger } from '#utils/logger.js';

interface AnalysisContext {
  expectedContent?: 'search-results' | 'profile';
  action?: string;
}

/**
 * ContentSignalAnalyzer examines page content and URL for soft-block indicators.
 */
export class ContentSignalAnalyzer {
  constructor(private selectorResolver?: SelectorResolver) {}

  /**
   * Analyze the current page for signals
   */
  async analyzePage(
    page: Page,
    detector: SignalDetector,
    context: AnalysisContext = {}
  ): Promise<void> {
    const url = page.url();

    // a. URL Analysis
    if (this._isCheckpointUrl(url)) {
      detector.recordContentSignal('checkpoint-detected', url);
    }

    // b. Login redirect detection
    if (this._isUnexpectedLoginRedirect(url, context.action)) {
      detector.recordContentSignal('login-redirect', url);
    }

    // c. Banner detection
    await this._detectRestrictionBanners(page, detector);

    // d. Empty results detection
    if (context.expectedContent === 'search-results') {
      await this._detectEmptySearchResults(page, detector);
    }

    // e. Missing DOM elements
    if (context.expectedContent === 'profile') {
      await this._detectMissingProfileIndicators(page, detector);
    }
  }

  private _isCheckpointUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.includes('checkpoint') ||
      lowerUrl.includes('authwall') ||
      lowerUrl.includes('challenge') ||
      lowerUrl.includes('captcha')
    );
  }

  private _isUnexpectedLoginRedirect(url: string, action?: string): boolean {
    const lowerUrl = url.toLowerCase();
    const isLoginPage = lowerUrl.includes('/login') || lowerUrl.includes('/uas/login');
    return isLoginPage && action !== 'login';
  }

  private async _detectRestrictionBanners(page: Page, detector: SignalDetector): Promise<void> {
    const restrictionKeywords = [
      'unusual activity',
      'temporarily restricted',
      "we've restricted your account",
      'verify your identity',
      'security verification',
      'restricted your account',
    ];

    try {
      const detectedBanner = await page.evaluate((keywords) => {
        const text = document.body.innerText.toLowerCase();
        return keywords.find((keyword) => text.includes(keyword));
      }, restrictionKeywords);

      if (detectedBanner) {
        detector.recordContentSignal('unusual-activity-banner', detectedBanner);
      }
    } catch (error) {
      logger.error('[ContentSignalAnalyzer] Error during banner detection:', error);
    }
  }

  private async _detectEmptySearchResults(page: Page, detector: SignalDetector): Promise<void> {
    if (!this.selectorResolver) return;

    try {
      const results = await this.selectorResolver.resolveAll(page, 'search:result-items');
      if (results.length === 0) {
        // Double check it's a search page
        const url = page.url();
        if (url.includes('/search/results/')) {
          detector.recordContentSignal('empty-results', 'No search results found on search page');
        }
      }
    } catch {
      // Ignore errors from resolver
    }
  }

  private async _detectMissingProfileIndicators(
    page: Page,
    detector: SignalDetector
  ): Promise<void> {
    if (!this.selectorResolver) return;

    try {
      const indicator = await this.selectorResolver.resolve(page, 'nav:profile-indicator');
      if (!indicator) {
        detector.recordContentSignal('missing-dom-elements', 'Profile indicators not found');
      }
    } catch {
      // Ignore
    }
  }
}

// Singleton pattern
let contentAnalyzer: ContentSignalAnalyzer | null = null;

export function getContentAnalyzer(resolver?: SelectorResolver): ContentSignalAnalyzer {
  if (!contentAnalyzer) {
    contentAnalyzer = new ContentSignalAnalyzer(resolver);
  }
  return contentAnalyzer;
}

/** Reset the module-level singleton. Only call from _resetForTesting(). */
export function _resetContentAnalyzerForTesting(): void {
  contentAnalyzer = null;
}
