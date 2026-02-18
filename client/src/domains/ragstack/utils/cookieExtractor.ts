/**
 * Cookie Extraction Utility
 *
 * Extracts and serializes cookies from Puppeteer browser sessions
 * for use with RAGStack authenticated scraping.
 */

import type { Page, Cookie } from 'puppeteer';
import { logger } from '#utils/logger.js';

/**
 * LinkedIn cookie names that are essential for authentication
 */
const ESSENTIAL_LINKEDIN_COOKIES = [
  'li_at', // Main auth token
  'JSESSIONID', // Session ID
  'liap', // Auth preference
  'li_rm', // Remember me
];

/**
 * Check if a cookie domain matches LinkedIn or the local mock server.
 */
function isLinkedInDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d === 'linkedin.com' || d === '.linkedin.com' || d.endsWith('.linkedin.com');
}

function isLocalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d === 'localhost' || d === '127.0.0.1';
}

/**
 * Extract LinkedIn cookies from a Puppeteer page and serialize them.
 *
 * In testing mode (LINKEDIN_TESTING_MODE=true), accepts localhost cookies
 * since the browser is pointed at the mock server instead of linkedin.com.
 *
 * @param page - Puppeteer Page instance with active LinkedIn session
 * @returns Serialized cookie string (e.g., "li_at=xxx; JSESSIONID=yyy")
 * @throws Error if no LinkedIn cookies found
 */
export async function extractLinkedInCookies(page: Page): Promise<string> {
  const cookies = await page.cookies();
  const testingMode = process.env.LINKEDIN_TESTING_MODE === 'true';

  const matchedCookies = cookies.filter((cookie) => {
    const domain = cookie.domain;
    return isLinkedInDomain(domain) || (testingMode && isLocalDomain(domain));
  });

  if (matchedCookies.length === 0) {
    throw new Error('No LinkedIn cookies found. User may not be logged in.');
  }

  // Check for essential auth cookies (skip in testing mode)
  if (!testingMode) {
    const cookieNames = new Set(matchedCookies.map((c) => c.name));
    const hasAuthCookie = ESSENTIAL_LINKEDIN_COOKIES.some((name) => cookieNames.has(name));

    if (!hasAuthCookie) {
      logger.warn(
        'LinkedIn cookies found but no essential auth cookies (li_at, JSESSIONID). ' +
          'Scraping may fail due to missing authentication.'
      );
    }
  }

  const serialized = serializeCookies(matchedCookies);
  const cookieNames = matchedCookies.map((c) => c.name);

  logger.debug(
    `Extracted ${matchedCookies.length} cookies${testingMode ? ' (testing mode)' : ''}`,
    {
      cookieNames,
      serializedLength: serialized.length,
    }
  );

  return serialized;
}

/**
 * Serialize cookies to standard HTTP cookie format.
 *
 * @param cookies - Array of Puppeteer Cookie objects
 * @returns Serialized string (e.g., "name1=value1; name2=value2")
 */
export function serializeCookies(cookies: Cookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Check if LinkedIn session appears valid based on cookies.
 *
 * @param page - Puppeteer Page instance
 * @returns True if essential auth cookies are present
 */
export async function hasValidLinkedInSession(page: Page): Promise<boolean> {
  try {
    const cookies = await page.cookies();
    const linkedInCookies = cookies.filter((c) => {
      const domain = c.domain.toLowerCase();
      return (
        domain === 'linkedin.com' || domain === '.linkedin.com' || domain.endsWith('.linkedin.com')
      );
    });
    const cookieNames = new Set(linkedInCookies.map((c) => c.name));

    return ESSENTIAL_LINKEDIN_COOKIES.some((name) => cookieNames.has(name));
  } catch {
    return false;
  }
}
