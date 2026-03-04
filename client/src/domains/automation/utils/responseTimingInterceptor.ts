import { Page, HTTPResponse, HTTPRequest } from 'puppeteer';
import { SignalDetector } from './signalDetector.js';
import { logger } from '#utils/logger.js';

/**
 * Intercepts Puppeteer page responses to measure timing and HTTP status codes,
 * feeding them into the SignalDetector.
 */
export class ResponseTimingInterceptor {
  private page: Page | null = null;
  private detector: SignalDetector | null = null;
  private pendingRequests: Map<HTTPRequest, number> = new Map();

  private onResponseBound = this.onResponse.bind(this);
  private onRequestBound = this.onRequest.bind(this);
  private onRequestFailedBound = this.onRequestFailed.bind(this);
  private onFrameNavigatedBound = this.onFrameNavigated.bind(this);

  /**
   * Attach the interceptor to a Puppeteer page
   */
  attachToPage(page: Page, detector: SignalDetector): void {
    if (this.page) {
      this.detach();
    }

    this.page = page;
    this.detector = detector;

    this.page.on('request', this.onRequestBound);
    this.page.on('response', this.onResponseBound);
    this.page.on('requestfailed', this.onRequestFailedBound);
    this.page.on('framenavigated', this.onFrameNavigatedBound);

    logger.debug('[ResponseTimingInterceptor] Attached to page');
  }

  /**
   * Detach the interceptor from the page
   */
  detach(): void {
    if (!this.page) return;

    this.page.off('request', this.onRequestBound);
    this.page.off('response', this.onResponseBound);
    this.page.off('requestfailed', this.onRequestFailedBound);
    this.page.off('framenavigated', this.onFrameNavigatedBound);

    this.page = null;
    this.detector = null;
    this.pendingRequests.clear();

    logger.debug('[ResponseTimingInterceptor] Detached from page');
  }

  private onRequest(request: HTTPRequest): void {
    const url = request.url();
    if (this._isMeaningfulLinkedInRequest(url)) {
      this.pendingRequests.set(request, Date.now());
    }
  }

  private onResponse(response: HTTPResponse): void {
    const request = response.request();
    const startTime = this.pendingRequests.get(request);

    if (startTime) {
      const durationMs = Date.now() - startTime;
      this.pendingRequests.delete(request);

      const url = response.url();
      const status = response.status();

      if (this.detector) {
        this.detector.recordResponseTiming(url, durationMs);
        this.detector.recordHttpStatus(url, status);
      }
    }
  }

  private onRequestFailed(request: HTTPRequest): void {
    this.pendingRequests.delete(request);
  }

  private onFrameNavigated(): void {
    // Clear in-flight requests abandoned due to navigation
    this.pendingRequests.clear();
  }

  /**
   * Filter for meaningful LinkedIn requests (API calls, navigations)
   * Excludes static assets and third-party trackers.
   */
  private _isMeaningfulLinkedInRequest(url: string): boolean {
    try {
      const urlObj = new URL(url);

      // Only include LinkedIn domains
      if (!urlObj.hostname.includes('linkedin.com')) {
        return false;
      }

      const pathname = urlObj.pathname.toLowerCase();

      // Exclude static assets
      const excludedExtensions = [
        '.js',
        '.css',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.svg',
        '.woff',
        '.woff2',
        '.ico',
      ];
      if (excludedExtensions.some((ext) => pathname.endsWith(ext))) {
        return false;
      }

      // Exclude tracking/analytics if obvious
      if (pathname.includes('/li/track') || pathname.includes('/collect')) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const responseTimingInterceptor = new ResponseTimingInterceptor();

export default ResponseTimingInterceptor;
