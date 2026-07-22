/**
 * Mutual Connections Collector
 *
 * Given a 1st-degree contact, navigates once to that contact's shared/mutual
 * connections surface and returns the public slugs of the user's OTHER contacts
 * found there (per-card attribution — one shared connection per result card,
 * following the container-walk pattern in puppeteerService.extractProfilePictures
 * rather than a flat link set).
 *
 * Verbatim/public per B-2 ADR-8, but inert until wired behind the consent gate
 * (Task 6). Degrades gracefully: if the surface is absent for a contact, or a
 * navigation fails, it returns an empty list and never throws into the
 * ingestion loop.
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { logger } from '#utils/logger.js';
import { sharedConnectionsSelectors } from '../selectors/sharedConnectionsSelectors.js';
import type { Page } from 'puppeteer';

type CheerioRoot = ReturnType<typeof cheerio.load>;

const PAGE_SETTLE_MS = 2500;
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9\-_.~%]+$/;
// Bound the per-contact yield so a pathological page can't explode the write batch.
const MAX_SHARED_CONNECTIONS = 100;

export interface MutualConnection {
  /** LinkedIn public profile slug of the shared connection (e.g. "jane-doe"). */
  profileId: string;
}

/**
 * Collects the shared connections between the user and one of their contacts,
 * using the existing Puppeteer session and cheerio HTML parsing.
 */
export class MutualConnectionsCollector {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * One extra navigation: visit the contact's shared-connections surface and
   * parse the shared connections. Returns [] when the surface is absent or on
   * any failure (never throws).
   *
   * @param contactProfileId LinkedIn public slug of the 1st-degree contact.
   */
  async collectSharedConnections(contactProfileId: string): Promise<MutualConnection[]> {
    if (!contactProfileId || !PROFILE_ID_PATTERN.test(contactProfileId)) {
      logger.warn('Invalid contact profile id for mutual collection', { contactProfileId });
      return [];
    }

    try {
      await this.page.goto(this._sharedConnectionsUrl(contactProfileId), {
        waitUntil: 'networkidle2',
      });
      await this._settle();

      const html = await this.page.content();
      const $ = cheerio.load(html);
      return this._parseSharedConnections($, contactProfileId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn('Mutual-connections collection failed (non-fatal)', {
        contactProfileId,
        error: errMsg,
      });
      return [];
    }
  }

  /**
   * Build the single shared-connections URL for a contact: your 1st-degree
   * connections (network=["F"]) who are also connected to the contact.
   *
   * FEASIBILITY GATE (see docs/plans/2026-07-19-warm-intro-pathways/Phase-1-notes.md):
   * the `connectionOf` parameter is passed the contact's public vanity slug.
   * LinkedIn's people-search may instead require a member/entity identifier, in
   * which case this surface renders no results and collection silently yields
   * nothing (the collector degrades to []). The correct identifier MUST be
   * confirmed by the manual live-session feasibility check before this path is
   * activated for real collection — do not treat the current slug form as
   * verified.
   */
  _sharedConnectionsUrl(contactProfileId: string): string {
    const connectionOf = encodeURIComponent(JSON.stringify([contactProfileId]));
    const network = encodeURIComponent(JSON.stringify(['F']));
    return (
      `https://www.linkedin.com/search/results/people/?connectionOf=${connectionOf}` +
      `&network=${network}&origin=MEMBER_PROFILE_CANNED_SEARCH`
    );
  }

  /**
   * Walk each result card and attribute exactly one shared-connection slug per
   * card. Dedupes and skips the contact itself; caps at MAX_SHARED_CONNECTIONS.
   */
  _parseSharedConnections($: CheerioRoot, contactProfileId: string): MutualConnection[] {
    const list = this._resolve($, 'shared-connections:results-list');
    if (!list) {
      return [];
    }

    const items = this._resolve(cheerio.load(list.html() || ''), 'shared-connections:result-item');
    if (!items) {
      return [];
    }

    const seen = new Set<string>();
    const results: MutualConnection[] = [];

    items.each((_: number, el: AnyNode) => {
      if (results.length >= MAX_SHARED_CONNECTIONS) return;
      const $card = cheerio.load(el);
      const slug = this._extractCardSlug($card);
      if (!slug || slug === contactProfileId || seen.has(slug)) return;
      seen.add(slug);
      results.push({ profileId: slug });
    });

    return results;
  }

  /**
   * Extract the single profile slug attributed to one card, trying the
   * profile-link cascade in order.
   */
  _extractCardSlug($card: CheerioRoot): string | null {
    const cascade = sharedConnectionsSelectors['shared-connections:profile-link'];
    if (!cascade) return null;
    for (const { selector } of cascade) {
      const href = $card(selector).first().attr('href');
      const slug = this._slugFromHref(href);
      if (slug) return slug;
    }
    return null;
  }

  /** Parse the `/in/{slug}` segment out of a profile href. */
  _slugFromHref(href: string | undefined): string | null {
    if (!href) return null;
    const match = href.match(/\/in\/([^/?#\s]+)/);
    const slug = match?.[1]?.replace(/\/$/, '');
    if (!slug || !PROFILE_ID_PATTERN.test(slug)) return null;
    return slug;
  }

  /** Resolve a selector cascade against a cheerio instance; first match wins. */
  _resolve($: CheerioRoot, selectorKey: string) {
    const cascade = sharedConnectionsSelectors[selectorKey];
    if (!cascade) return null;
    for (const { selector } of cascade) {
      const result = $(selector);
      if (result.length > 0) return result;
    }
    return null;
  }

  /** Wait briefly for lazy-loaded results to render. */
  async _settle() {
    return new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_MS));
  }
}
