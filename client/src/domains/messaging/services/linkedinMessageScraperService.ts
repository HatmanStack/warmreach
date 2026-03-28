/**
 * LinkedIn Message Scraper Service - Reads/extracts messages from LinkedIn's messaging UI.
 *
 * Follows the same patterns as linkedinService.ts (multi-selector fallbacks,
 * intelligent scrolling, random delays).
 */

import { logger } from '#utils/logger.js';
import { linkedinResolver, linkedinSelectors } from '../../linkedin/selectors/index.js';
import type { Page } from 'puppeteer';

const MAX_MESSAGES_PER_EDGE = 100;

interface SessionManagerLike {
  getInstance(opts: { reinitializeIfUnhealthy: boolean }): Promise<{
    getPage(): Page | null;
  }>;
}

interface ScraperOptions {
  sessionManager?: SessionManagerLike;
}

interface ScrapeOptions {
  maxConversations?: number;
  maxScrolls?: number;
}

interface ConversationEntry {
  profileId: string;
  index: number;
}

interface ScrapedMessage {
  id: string;
  content: string;
  timestamp: string | null;
  timestampApproximate: boolean;
  sender: string;
}

/**
 * Random delay helper (inline to avoid import complexity).
 */
function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs);
  const delayMs = minMs + Math.floor(Math.random() * (span + 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Build a comma-separated CSS selector string from the selector registry,
 * filtering out Puppeteer-specific pseudo selectors.
 */
function buildSelectorString(key: string): string {
  const cascade = linkedinSelectors[key] ?? [];
  return cascade
    .filter((s) => !s.selector.includes('::-p-'))
    .map((s) => s.selector)
    .join(', ');
}

/**
 * Service dedicated to reading/extracting messages from LinkedIn's messaging UI.
 */
export class LinkedInMessageScraperService {
  private sessionManager: SessionManagerLike;

  constructor(options: ScraperOptions = {}) {
    if (!options.sessionManager) {
      throw new Error('LinkedInMessageScraperService requires sessionManager');
    }
    this.sessionManager = options.sessionManager;
  }

  /**
   * Main entry point for profile init: scrape all conversations matching known connection IDs.
   */
  async scrapeAllConversations(
    connectionProfileIds: string[],
    options: ScrapeOptions = {}
  ): Promise<Map<string, ScrapedMessage[]>> {
    const maxConversations = options.maxConversations || 50;
    const maxScrolls = options.maxScrolls || 20;
    const results = new Map<string, ScrapedMessage[]>();

    if (!connectionProfileIds || connectionProfileIds.length === 0) {
      logger.info('No connection profile IDs provided, skipping message scraping');
      return results;
    }

    const connectionSet = new Set(connectionProfileIds);

    try {
      await this._navigateToMessaging();
      await this._delay(1500, 2500);

      await this._scrollConversationList(maxScrolls);

      const conversationEntries = await this._extractConversationEntries();
      logger.info(`Found ${conversationEntries.length} conversations in sidebar`);

      // Filter to only conversations matching known connections
      const matchingEntries = conversationEntries.filter((entry: ConversationEntry) =>
        connectionSet.has(entry.profileId)
      );
      logger.info(
        `${matchingEntries.length} conversations match known connections (of ${connectionProfileIds.length} total)`
      );

      // Process up to maxConversations
      const toProcess = matchingEntries.slice(0, maxConversations);

      for (const entry of toProcess) {
        try {
          await this._clickConversation(entry);
          await this._delay(1000, 2000);

          await this._scrollThreadUp(10);

          const messages = await this._extractMessages();
          if (messages.length > 0) {
            results.set(entry.profileId, messages.slice(-MAX_MESSAGES_PER_EDGE));
            logger.info(`Scraped ${messages.length} messages for ${entry.profileId}`);
          }

          await this._delay(1000, 2000);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to scrape conversation for ${entry.profileId}: ${errMsg}`);
          // Continue with remaining conversations
        }
      }

      logger.info(`Message scraping complete: ${results.size} conversations scraped`);
      return results;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Message scraping failed: ${errMsg}`);
      return results; // Return partial results
    }
  }

  /**
   * Extract messages from a single open/navigated conversation thread.
   */
  async scrapeConversationThread(profileId: string): Promise<ScrapedMessage[]> {
    try {
      const page = await this._getPage();

      // Check if we're already on a messaging thread, otherwise navigate
      const currentUrl = page.url();
      if (!currentUrl.includes('/messaging/')) {
        await this._navigateToMessaging();
        await this._delay(1000, 1500);
      }

      // Try to find and click the conversation for this profile in the sidebar
      const conversationEntries = await this._extractConversationEntries();
      const targetEntry = conversationEntries.find(
        (e: ConversationEntry) => e.profileId === profileId
      );

      if (!targetEntry) {
        logger.warn(
          `No conversation found for ${profileId} in sidebar (${conversationEntries.length} conversations available)`
        );
        return [];
      }

      await this._clickConversation(targetEntry);
      await this._delay(1000, 1500);

      await this._scrollThreadUp(10);
      const messages = await this._extractMessages();

      logger.info(`Scraped ${messages.length} messages from thread for ${profileId}`);
      return messages.slice(-MAX_MESSAGES_PER_EDGE);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to scrape conversation thread for ${profileId}: ${errMsg}`);
      return [];
    }
  }

  /**
   * Navigate to LinkedIn's /messaging/ page.
   */
  private async _navigateToMessaging(): Promise<void> {
    const page = await this._getPage();

    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    try {
      await linkedinResolver.resolveWithWait(page, 'messaging:conversation-list', {
        timeout: 8000,
      });
      return;
    } catch {
      logger.warn('Could not confirm messaging page loaded via selectors');
    }
  }

  /**
   * Scroll the conversation sidebar to load all conversations.
   * Uses intelligent stop: halts when conversation count stabilizes.
   */
  private async _scrollConversationList(maxScrolls = 20): Promise<void> {
    const page = await this._getPage();
    let previousCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < maxScrolls; i++) {
      const itemSel = buildSelectorString('messaging:conversation-items');

      const currentCount = await page.evaluate((selString: string) => {
        let max = 0;
        if (!selString) return 0;
        selString.split(',').forEach((sel: string) => {
          const items = document.querySelectorAll(sel.trim());
          if (items.length > max) max = items.length;
        });
        return max;
      }, itemSel);

      if (currentCount === previousCount) {
        stableRounds++;
        if (stableRounds >= 3) {
          logger.debug(
            `Conversation list stabilized at ${currentCount} items after ${i + 1} scrolls`
          );
          break;
        }
      } else {
        stableRounds = 0;
      }
      previousCount = currentCount;

      const containerSel = buildSelectorString('messaging:conversation-list');

      // Scroll the conversation list container
      await page.evaluate((selString: string) => {
        if (!selString) return;
        const selectors = selString.split(',');
        for (const sel of selectors) {
          const container = document.querySelector(sel.trim());
          if (container) {
            container.scrollTop = container.scrollHeight;
            return;
          }
        }
      }, containerSel);

      await this._delay(800, 1500);
    }
  }

  /**
   * Extract conversation entries from the sidebar.
   */
  private async _extractConversationEntries(): Promise<ConversationEntry[]> {
    const page = await this._getPage();
    const itemSel = buildSelectorString('messaging:conversation-items');

    return await page.evaluate((selString: string) => {
      const entries: { profileId: string; index: number }[] = [];
      if (!selString) return entries;
      const selectors = selString.split(',');
      let items: Element[] = [];
      for (const sel of selectors) {
        items = Array.from(document.querySelectorAll(sel.trim()));
        if (items.length > 0) break;
      }

      items.forEach((item, index) => {
        // Find profile link within conversation item
        const profileLink = item.querySelector('a[href*="/in/"]');
        if (profileLink) {
          const href = profileLink.getAttribute('href') || '';
          const match = href.match(/\/in\/([^/?\s]+)/);
          if (match?.[1]) {
            entries.push({
              profileId: match[1].replace(/\/$/, ''),
              index,
            });
          }
        }
      });

      return entries;
    }, itemSel);
  }

  /**
   * Click a conversation in the sidebar and wait for thread to load.
   */
  private async _clickConversation(entry: ConversationEntry): Promise<void> {
    const page = await this._getPage();
    const itemSel = buildSelectorString('messaging:conversation-items');

    await page.evaluate(
      (idx: number, selString: string) => {
        if (!selString) return;
        const selectors = selString.split(',');
        for (const sel of selectors) {
          const items = document.querySelectorAll(sel.trim());
          if (items.length > idx) {
            // Click the item or its first clickable child
            const target = items[idx]!;
            const clickable = target.querySelector('a') || target;
            (clickable as HTMLElement).click();
            return;
          }
        }
      },
      entry.index,
      itemSel
    );

    // Wait for message thread to load
    try {
      await linkedinResolver.resolveWithWait(page, 'messaging:message-list', { timeout: 5000 });
      return;
    } catch {
      // try next
    }
  }

  /**
   * Scroll up in the message thread to load older messages.
   */
  private async _scrollThreadUp(maxScrolls = 10): Promise<void> {
    const page = await this._getPage();
    let previousCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < maxScrolls; i++) {
      const itemSel = buildSelectorString('messaging:message-events');

      const currentCount = await page.evaluate((selString: string) => {
        let max = 0;
        if (!selString) return 0;
        selString.split(',').forEach((sel: string) => {
          const items = document.querySelectorAll(sel.trim());
          if (items.length > max) max = items.length;
        });
        return max;
      }, itemSel);

      if (currentCount === previousCount) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      previousCount = currentCount;

      const containerSel = buildSelectorString('messaging:message-list');

      // Scroll the thread container up
      await page.evaluate((selString: string) => {
        if (!selString) return;
        const selectors = selString.split(',');
        for (const sel of selectors) {
          const container = document.querySelector(sel.trim());
          if (container) {
            container.scrollTop = 0;
            return;
          }
        }
      }, containerSel);

      await this._delay(800, 1200);
    }
  }

  /**
   * Extract messages from the currently visible thread.
   */
  private async _extractMessages(): Promise<ScrapedMessage[]> {
    const page = await this._getPage();
    const eventsSel = buildSelectorString('messaging:message-events');
    const timeSel = buildSelectorString('messaging:timestamp');
    const otherSel = buildSelectorString('messaging:other-message');

    return await page.evaluate(
      (evtSel: string, tSel: string, oSel: string) => {
        const messages: {
          id: string;
          content: string;
          timestamp: string | null;
          timestampApproximate: boolean;
          sender: string;
        }[] = [];
        if (!evtSel) return messages;

        let items: Element[] = [];
        for (const sel of evtSel.split(',')) {
          items = Array.from(document.querySelectorAll(sel.trim()));
          if (items.length > 0) break;
        }

        items.forEach((item, index) => {
          // Extract content
          const contentSelectors = [
            '.msg-s-event-listitem__body',
            'p[dir="ltr"]',
            '.msg-s-event__content',
          ];
          let content = '';
          for (const sel of contentSelectors) {
            const el = item.querySelector(sel);
            if (el && el.textContent?.trim()) {
              content = el.textContent.trim();
              break;
            }
          }

          if (!content) return; // Skip non-message events (e.g., connection requests)

          // Extract timestamp: only use exact datetime, never synthesize scrape time
          let timestamp: string | null = null;
          let timestampApproximate = false;
          let timeEl: Element | null = null;

          if (tSel) {
            for (const sel of tSel.split(',')) {
              timeEl = item.querySelector(sel.trim());
              if (timeEl) break;
            }
          }

          if (timeEl) {
            const dt = timeEl.getAttribute('datetime');
            if (dt) {
              timestamp = dt;
            } else if (timeEl.textContent) {
              // Relative text like "3 hours ago": not a reliable ISO timestamp
              timestamp = timeEl.textContent.trim();
              timestampApproximate = true;
            }
          }

          // Determine sender: presence of "other" class indicates inbound
          let isInbound = false;
          if (oSel) {
            for (const sel of oSel.split(',')) {
              if (
                (item.matches && item.matches(sel.trim())) ||
                item.querySelector(sel.trim()) !== null ||
                item.closest(sel.trim()) !== null
              ) {
                isInbound = true;
                break;
              }
            }
          }

          messages.push({
            id: `msg-${Date.now()}-${index}`,
            content,
            timestamp,
            timestampApproximate,
            sender: isInbound ? 'inbound' : 'outbound',
          });
        });

        return messages;
      },
      eventsSel,
      timeSel,
      otherSel
    );
  }

  /**
   * Rate-limiting delay between actions. Extracted as a method for testability.
   */
  async _delay(minMs: number, maxMs: number): Promise<void> {
    await randomDelay(minMs, maxMs);
  }

  /**
   * Get the Puppeteer page from the session manager.
   */
  private async _getPage(): Promise<Page> {
    const session = await this.sessionManager.getInstance({
      reinitializeIfUnhealthy: false,
    });
    const page = session.getPage();
    if (!page) throw new Error('No active page in browser session');
    return page;
  }
}
