/**
 * Local Profile Scraper
 *
 * Uses Puppeteer to navigate to LinkedIn profiles and extracts
 * structured data using cheerio CSS selectors against static HTML.
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '#utils/logger.js';
import { config } from '#shared-config/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { profileSelectors } from '../selectors/profileSelectors.js';
import type { Page } from 'puppeteer';

type CheerioRoot = ReturnType<typeof cheerio.load>;

const MAX_ACTIVITY_POSTS = 10;
const PAGE_SETTLE_MS = 2500;
// Bounded auto-scroll budget: enough to render the profile's Experience/
// Education/Skills cards without chasing the infinite recommendation feed.
const MAX_SCROLL_PX = 14000;
const SCROLL_STEP_MS = 450;
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9\-_.~%]+$/;

interface ExperienceEntry {
  company: string;
  title: string;
  dateRange: string;
  description: string;
}

interface EducationEntry {
  school: string;
  degree: string;
  dateRange: string;
}

interface ActivityEntry {
  text: string;
  timestamp: string;
}

interface ProfileData {
  name: string | null;
  headline: string | null;
  location: string | null;
  about: string | null;
  profilePictureUrl: string | null;
  currentPosition: ExperienceEntry | null;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: string[];
  recentActivity: ActivityEntry[];
}

/**
 * Local profile scraper that extracts structured data from LinkedIn profiles
 * using the existing Puppeteer browser session and cheerio HTML parsing.
 */
export class LocalProfileScraper {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Scrape a LinkedIn profile and its recent activity.
   *
   * @param {string} profileId - LinkedIn profile slug (e.g., "jane-doe")
   * @returns {Promise<Object>} Structured profile data
   */
  async scrapeProfile(profileId: string): Promise<ProfileData> {
    if (!profileId || !PROFILE_ID_PATTERN.test(profileId)) {
      throw new LinkedInError(`Invalid profile ID: ${profileId}`, 'INVALID_PROFILE_ID');
    }

    // Navigate to profile page
    const profileUrl = `https://www.linkedin.com/in/${profileId}/`;
    logger.info('[scrape] navigating to profile', { phase: 'scrape', profileId, url: profileUrl });
    await this.page.goto(profileUrl, {
      waitUntil: 'networkidle2',
    });
    await this._settle();

    // LinkedIn's 2026 profile lazy-mounts the lower cards (Experience,
    // Education, full Skills) only as the viewport scrolls past them. Nudge the
    // page down a bounded distance so those cards render before we snapshot the
    // DOM, then return to the top. Bounded so we don't chase the effectively
    // infinite recommendation feed below the profile.
    await this._autoScroll();
    await this._settle();

    // Where did we actually land? A redirect to /authwall, /login, or a
    // checkpoint means the headless session isn't authenticated for scraping,
    // and every cheerio field below will silently come back empty. Surfacing
    // the landed URL + page title is the single most useful signal for the
    // "list appears but no names" symptom.
    const landedUrl = this.page.url();
    const pageTitle = await this.page.title().catch(() => '');
    const profileHtml = await this.page.content();
    const onAuthWall = /\/(authwall|login|checkpoint|uas\/login|signup)/i.test(landedUrl);
    logger.info('[scrape] profile page loaded', {
      phase: 'scrape',
      profileId,
      landedUrl,
      pageTitle,
      htmlLength: profileHtml.length,
      redirectedAwayFromProfile: !landedUrl.includes(`/in/${profileId}`),
      onAuthWall,
    });
    if (onAuthWall) {
      logger.warn(
        '[scrape] landed on an auth/login wall — session is not authenticated for scraping, so all fields will be empty',
        { phase: 'scrape', profileId, landedUrl }
      );
    }

    // Dump the raw HTML for offline selector analysis when explicitly enabled
    // (PROFILE_SCRAPE_DUMP_HTML=true). The 2026 markup changed, so this is how
    // we recover exact selectors without guessing.
    if (config.linkedin.scrapeDumpHtml) {
      await this._dumpHtml(profileId, profileHtml);
    }

    const $ = cheerio.load(profileHtml);

    // Extract profile fields. The name cascade is markup-dependent and brittle
    // across LinkedIn redesigns; the page <title> ("Name | LinkedIn") is far
    // more stable, so try the cascade first and fall back to the title.
    const name = this._nameFromTitle(pageTitle) || this._extractText($, 'profile:scrape-name');
    const headline = this._extractHeadline($, name);
    const about = this._extractAbout($);
    const skills = this._extractSkills($);
    const location = this._extractLocation($);
    const profilePictureUrl = this._extractProfilePicture($, profileId, name);

    if (!name) {
      logger.warn(
        '[scrape] No name found for profile — selectors may be stale, or the page is not a rendered profile',
        { phase: 'scrape', profileId, landedUrl }
      );
    }

    // Experience and education left the main profile page in the 2026 redesign
    // — each lives on its own /details/ route. Fetch them individually
    // (best-effort; a failed sub-page is non-fatal and yields empty).
    const experience = await this._scrapeDetailExperience(profileId);
    const education = await this._scrapeDetailEducation(profileId);

    // Derive current position from first experience entry
    const currentPosition = experience.length > 0 ? experience[0]! : null;

    logger.info('[scrape] extracted core fields', {
      phase: 'scrape',
      profileId,
      name: name ?? '(empty)',
      headline: headline ?? '(empty)',
      location: location ?? '(empty)',
      aboutLength: about?.length ?? 0,
      experienceCount: experience.length,
      educationCount: education.length,
      skillsCount: skills.length,
      hasProfilePicture: !!profilePictureUrl,
    });

    // Navigate to activity page (non-fatal)
    let recentActivity: ActivityEntry[] = [];
    try {
      const activityUrl = `https://www.linkedin.com/in/${profileId}/recent-activity/all/`;
      logger.debug('[scrape] navigating to recent activity', {
        phase: 'scrape',
        profileId,
        url: activityUrl,
      });
      await this.page.goto(activityUrl, {
        waitUntil: 'networkidle2',
      });
      await this._settle();

      const activityHtml = await this.page.content();
      const $activity = cheerio.load(activityHtml);
      recentActivity = this._extractActivity($activity);
      logger.info('[scrape] extracted recent activity', {
        phase: 'scrape',
        profileId,
        activityCount: recentActivity.length,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[scrape] Failed to load activity page (non-fatal)', {
        phase: 'scrape',
        profileId,
        error: errMsg,
      });
    }

    const result: ProfileData = {
      name,
      headline,
      location,
      about,
      profilePictureUrl,
      currentPosition,
      experience,
      education,
      skills,
      recentActivity,
    };
    logger.info('[scrape] profile scrape complete', {
      phase: 'scrape',
      profileId,
      hasName: !!name,
      fieldsPopulated: [
        name && 'name',
        headline && 'headline',
        location && 'location',
        about && 'about',
        currentPosition && 'currentPosition',
        experience.length && 'experience',
        education.length && 'education',
        skills.length && 'skills',
        recentActivity.length && 'recentActivity',
      ].filter(Boolean),
    });
    return result;
  }

  /**
   * Resolve a selector cascade against a cheerio instance.
   * Returns the first matching cheerio selection, or null.
   */
  _resolveSelector($: CheerioRoot, selectorKey: string) {
    const cascade = profileSelectors[selectorKey];
    if (!cascade) {
      logger.warn('Unknown selector key', { selectorKey });
      return null;
    }

    for (const { strategy, selector } of cascade) {
      const result = $(selector);
      if (result.length > 0) {
        logger.debug('[scrape] selector matched', {
          phase: 'scrape',
          selectorKey,
          strategy,
          matchCount: result.length,
        });
        return result;
      }
    }

    logger.debug('[scrape] no selector in cascade matched', {
      phase: 'scrape',
      selectorKey,
      strategiesTried: cascade.length,
    });
    return null;
  }

  /**
   * Extract trimmed text from first match of a selector cascade.
   * Returns null if no match.
   */
  _extractText($: CheerioRoot, selectorKey: string): string | null {
    const el = this._resolveSelector($, selectorKey);
    if (!el) return null;
    const text = el.first().text().trim();
    return text || null;
  }

  /**
   * Find a section heading element whose exact text matches one of `labels`.
   * LinkedIn's 2026 profile uses per-deploy hashed class names, so headings can
   * only be anchored by their (stable) visible text, not by class. Scans
   * heading-ish tags in priority order and returns the raw node, or null.
   */
  _headingEl($: CheerioRoot, labels: string[]): AnyNode | null {
    const wanted = labels.map((l) => l.toLowerCase());
    let hit: AnyNode | null = null;
    for (const sel of ['h1', 'h2', 'h3', 'h4', 'p', 'span']) {
      $(sel).each((_: number, el: AnyNode) => {
        if (hit) return;
        if (wanted.includes($(el).text().trim().toLowerCase())) hit = el;
      });
      if (hit) break;
    }
    return hit;
  }

  /**
   * Headline: in the top card, the element carrying aria-label == the full name
   * wraps the name and, right after it, the headline. Return the first inner
   * <p> whose text isn't the name itself.
   */
  _extractHeadline($: CheerioRoot, name: string | null): string | null {
    if (!name) return null;
    let cardNode: AnyNode | null = null;
    $('[aria-label]').each((_: number, el: AnyNode) => {
      if (cardNode) return;
      if ($(el).attr('aria-label') === name) cardNode = el;
    });
    if (!cardNode) return null;
    let headline: string | null = null;
    $(cardNode)
      .find('p')
      .each((_: number, el: AnyNode) => {
        if (headline) return;
        const t = $(el).text().trim();
        if (t && t !== name) headline = t;
      });
    return headline;
  }

  /**
   * Member location from the top card. LinkedIn renders it as a low-emphasis
   * text line immediately before the "· Contact info" cluster, and "Contact
   * info" is a stable <a href="…/overlay/contact-info/"> link. Anchor on that
   * link and take the nearest preceding non-separator sibling text — robust to
   * the per-deploy hashed classes. Returns null when the link is absent (e.g. a
   * connection whose contact info isn't visible).
   */
  _extractLocation($: CheerioRoot): string | null {
    const contact = $('a[href*="/overlay/contact-info/"]').first();
    if (!contact.length) return null;
    const ref = contact.closest('p').length ? contact.closest('p') : contact.parent();
    let location: string | null = null;
    ref.prevAll().each((_: number, el: AnyNode) => {
      if (location) return;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t !== '·' && t.toLowerCase() !== 'contact info') location = t;
    });
    return location;
  }

  /**
   * Member's own photo. A LinkedIn profile page is full of *other* people's
   * photos (feed, "people also viewed", suggestions), so the photo must be
   * tied to the member's identity, not just picked by position or fetch
   * priority. Strategy, most-specific first:
   *
   *   1. A photo wrapped in an `<a href="/in/{profileId}">` — a link to the
   *      member's OWN profile. Identity-exact and apostrophe-proof.
   *   2. A photo whose `alt` names the member ("View {Name}'s profile").
   *   3. Fallback: the above-the-fold hero (`fetchpriority="high"`), which is
   *      the top-card photo on pages that still mark it.
   *
   * Accepts both `profile-displayphoto` and `profile-framedphoto` (the
   * open-to-work / hiring frame). The image often carries only a `srcset`, so
   * read either and take the first URL token.
   *
   * This replaces the old connections-list scrape, which walked up from each
   * `/in/` anchor to a card container that no longer exists in the 2026 DOM and
   * fell back to the first `media.licdn.com` image on the page — the viewer's
   * own nav avatar — assigning the same photo to every connection.
   */
  _extractProfilePicture($: CheerioRoot, profileId: string, name: string | null): string | null {
    const pickFrom = (el: AnyNode): string | null => {
      const raw = $(el).attr('src') || $(el).attr('srcset') || '';
      if (!/(?:display|framed)photo/.test(raw)) return null;
      const first = raw.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
      return first.startsWith('http') ? first : null;
    };

    let url: string | null = null;

    // 1. Photo linked to the member's own profile.
    $(`a[href*="/in/${profileId}"]`).each((_: number, a: AnyNode) => {
      if (url) return;
      $(a)
        .find('img')
        .each((__: number, img: AnyNode) => {
          if (!url) {
            const u = pickFrom(img);
            if (u) url = u;
          }
        });
    });
    if (url) return url;

    // 2. Photo whose alt text names the member.
    if (name) {
      $('img[alt]').each((_: number, el: AnyNode) => {
        if (url) return;
        if (($(el).attr('alt') || '').includes(name)) {
          const u = pickFrom(el);
          if (u) url = u;
        }
      });
      if (url) return url;
    }

    // 3. Above-the-fold hero fallback.
    $('img[fetchpriority="high"]').each((_: number, el: AnyNode) => {
      if (!url) {
        const u = pickFrom(el);
        if (u) url = u;
      }
    });
    return url;
  }

  /**
   * Load a LinkedIn profile sub-page (e.g. details/experience/), scroll to
   * render lazy lists, optionally dump the HTML, and return a cheerio root.
   * Non-fatal: returns null on navigation failure.
   */
  async _loadSubPage(
    profileId: string,
    subpath: string,
    label: string
  ): Promise<CheerioRoot | null> {
    try {
      const url = `https://www.linkedin.com/in/${profileId}/${subpath}`;
      logger.debug(`[scrape] navigating to ${label}`, { phase: 'scrape', profileId, url });
      await this.page.goto(url, { waitUntil: 'networkidle2' });
      await this._settle();
      await this._autoScroll();
      await this._settle();
      const html = await this.page.content();
      const landedUrl = this.page.url();
      logger.info(`[scrape] ${label} loaded`, {
        phase: 'scrape',
        profileId,
        landedUrl,
        htmlLength: html.length,
        reachedTarget: landedUrl.includes(subpath.replace(/\/+$/, '')),
      });
      if (config.linkedin.scrapeDumpHtml) {
        await this._dumpHtml(`${profileId}--${label}`, html);
      }
      return cheerio.load(html);
    } catch (error) {
      logger.warn(`[scrape] failed to load ${label} (non-fatal)`, {
        phase: 'scrape',
        profileId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Experience now lives on /details/experience/ (2026 redesign). Fetch that
   * page and parse its entries.
   */
  async _scrapeDetailExperience(profileId: string): Promise<ExperienceEntry[]> {
    const $ = await this._loadSubPage(profileId, 'details/experience/', 'experience-detail');
    if (!$) return [];
    const entries = this._extractExperience($);
    logger.info('[scrape] parsed experience detail', {
      phase: 'scrape',
      profileId,
      count: entries.length,
    });
    return entries;
  }

  /**
   * Education now lives on /details/education/ (2026 redesign).
   */
  async _scrapeDetailEducation(profileId: string): Promise<EducationEntry[]> {
    const $ = await this._loadSubPage(profileId, 'details/education/', 'education-detail');
    if (!$) return [];
    const entries = this._extractEducation($);
    logger.info('[scrape] parsed education detail', {
      phase: 'scrape',
      profileId,
      count: entries.length,
    });
    return entries;
  }

  /**
   * About: anchored on the "About" heading; the body renders in a stable
   * data-testid="expandable-text-box" within the same card.
   */
  _extractAbout($: CheerioRoot): string | null {
    const h = this._headingEl($, ['About']);
    if (!h) return null;
    const $h = $(h);
    const section = $h.closest('section');
    const scope = section.length ? section : $h.parent();
    const box = scope.find('[data-testid="expandable-text-box"]').first();
    let text = (box.length ? box.text() : $h.next().text()).trim();
    // Strip the "…more" expander artifact LinkedIn appends to truncated text.
    text = text.replace(/\s*…\s*more\s*$/i, '').trim();
    return text || null;
  }

  /**
   * Skills: LinkedIn renders the "Top skills" card as a single bullet-joined
   * line ("A • B • C") immediately after the heading.
   */
  _extractSkills($: CheerioRoot): string[] {
    const h = this._headingEl($, ['Top skills', 'Skills']);
    if (!h) return [];
    const $h = $(h);
    let text = $h.next().text().trim();
    if (!text.includes('•')) {
      const section = $h.closest('section');
      if (section.length) {
        section.find('p, span').each((_: number, el: AnyNode) => {
          if (text.includes('•')) return;
          const t = $(el).text().trim();
          if (t.includes('•')) text = t;
        });
      }
    }
    return text.includes('•')
      ? text
          .split('•')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  /**
   * Split one entry anchor's inner text into ordered, de-duplicated visible
   * lines. LinkedIn's 2026 /details/ pages wrap each experience role and each
   * education entry in an <a href="/company/…"> or <a href="/school/…"> whose
   * stacked child text nodes are that entry's fields; flattening tags to
   * newlines recovers those fields as lines. Strips svg noise and collapses
   * screen-reader dupes.
   */
  _anchorLines($: CheerioRoot, el: AnyNode): string[] {
    const html = ($(el).html() || '').replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
    const raw = html.replace(/<[^>]+>/g, '\n');
    const lines: string[] = [];
    for (const rawLine of raw.split('\n')) {
      const line = rawLine
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      if (line && !/^[\s·•|]+$/.test(line) && lines[lines.length - 1] !== line) {
        lines.push(line);
      }
    }
    return lines;
  }

  /** A line that reads as a LinkedIn date range ("Jun 2024 - Present", "1995 – 2000"). */
  _isDateRange(line: string): boolean {
    return (
      /\b(19|20)\d{2}\b/.test(line) &&
      (/present/i.test(line) ||
        /[–-]/.test(line) ||
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(line))
    );
  }

  /** A line that carries a tenure duration ("6 yrs 9 mos", "3 mos"). */
  _hasDuration(line: string): boolean {
    return /\b\d+\s*(yr|yrs|year|years|mo|mos|month|months)\b/i.test(line);
  }

  /** An employment-type qualifier line ("Full-time", "Internship"). */
  _isEmploymentType(line: string): boolean {
    return /^(full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal|permanent)\b/i.test(
      line.trim()
    );
  }

  /**
   * Parse a /details/ section (Experience or Education) by walking its entry
   * anchors. LinkedIn wraps each entry in an <a href="/company/…"> or
   * <a href="/school/…">. Two anchor shapes appear:
   *   - a group header — [Organization, totalDuration(, location)] with no date
   *     line — which sets the organization the roles beneath it inherit. A
   *     grouped multi-role company prints its name only once, in this header.
   *   - an entry — contains a date line. Its first line is the title (role or
   *     school); the organization is the first non-employment-type line between
   *     the title and the date ("Company · Full-time" → "Company"), or, when a
   *     grouped role carries no company line of its own, the current header org.
   */
  _parseSection(
    $: CheerioRoot,
    sectionName: 'Experience' | 'Education'
  ): Array<{ title: string; org: string; dateRange: string }> {
    const section = $(`[data-testid^="profile_${sectionName}DetailsSection"]`);
    const scope = section.length ? section : $('main');
    const out: Array<{ title: string; org: string; dateRange: string }> = [];
    let currentOrg = '';
    scope.find('a[href*="/company/"], a[href*="/school/"]').each((_: number, el: AnyNode) => {
      const lines = this._anchorLines($, el).filter((l) => l !== sectionName);
      if (!lines.length) return;
      const dateIdx = lines.findIndex((l) => this._isDateRange(l));
      if (dateIdx === -1) {
        // A header anchor with no date line starts a new (multi-role) company
        // group. When it carries a tenure total, adopt its organization for the
        // roles that follow. Otherwise we can't confidently identify the org —
        // but it still begins a NEW group, so clear currentOrg rather than let
        // the PREVIOUS company leak into these roles (the wrong-employer bug).
        if (lines.length >= 2 && lines.some((l) => this._hasDuration(l))) {
          currentOrg = lines[0]!;
        } else {
          currentOrg = '';
        }
        return;
      }
      const title = lines[0]!;
      let org = '';
      for (const mid of lines.slice(1, dateIdx)) {
        if (this._isEmploymentType(mid)) continue;
        org = mid.includes('·') ? (mid.split('·')[0] ?? '').trim() : mid.trim();
        break;
      }
      if (!org) org = currentOrg;
      out.push({ title, org, dateRange: (lines[dateIdx]!.split('·')[0] ?? '').trim() });
    });
    return out;
  }

  /**
   * Experience entries, parsed from the /details/experience/ page.
   */
  _extractExperience($: CheerioRoot): ExperienceEntry[] {
    return this._parseSection($, 'Experience').map((e) => ({
      title: e.title,
      company: e.org,
      dateRange: e.dateRange,
      description: '',
    }));
  }

  /**
   * Education entries, parsed from the /details/education/ page.
   */
  _extractEducation($: CheerioRoot): EducationEntry[] {
    return this._parseSection($, 'Education').map((e) => ({
      school: e.title,
      degree: e.org,
      dateRange: e.dateRange,
    }));
  }

  /**
   * Extract a sub-field from a cheerio-loaded element using a selector cascade.
   * Used for structured fields within experience/education/activity items.
   */
  _extractSubField($el: CheerioRoot, selectorKey: string): string {
    const cascade = profileSelectors[selectorKey];
    if (!cascade) return '';
    for (const { selector } of cascade) {
      const match = $el(selector);
      if (match.length > 0) {
        return match.first().text().trim();
      }
    }
    return '';
  }

  /**
   * Extract recent activity posts, capped at MAX_ACTIVITY_POSTS.
   */
  _extractActivity($: CheerioRoot): ActivityEntry[] {
    const posts = this._resolveSelector($, 'profile:scrape-activity-post');
    if (!posts) return [];

    const activities: ActivityEntry[] = [];
    posts.each((i: number, el: AnyNode) => {
      if (i >= MAX_ACTIVITY_POSTS) return;

      const $post = cheerio.load(el);
      const text = this._extractSubField($post, 'profile:scrape-activity-text');
      const timestamp = this._extractSubField($post, 'profile:scrape-activity-time');

      activities.push({ text, timestamp });
    });

    return activities;
  }

  /**
   * Derive a display name from the page <title>, which LinkedIn renders as
   * "Name | LinkedIn" (optionally prefixed with a "(3) " notification count).
   * This is the most redesign-stable source for the name.
   */
  _nameFromTitle(title: string): string | null {
    if (!title) return null;
    const cleaned = title
      .replace(/\s*[|｜]\s*LinkedIn\s*$/i, '') // strip trailing " | LinkedIn"
      .replace(/^\(\d+\)\s*/, '') // strip "(3) " unread-count prefix
      .trim();
    return cleaned || null;
  }

  /**
   * Persist the raw profile HTML to <userData>/logs/profile-dumps for offline
   * selector analysis. Best-effort and capped to a few files; never throws.
   */
  async _dumpHtml(profileId: string, html: string): Promise<void> {
    try {
      let userData = process.cwd();
      try {
        const require_ = createRequire(import.meta.url);
        const electron = require_('electron') as { app?: { getPath?: (k: string) => string } };
        userData = electron?.app?.getPath?.('userData') || userData;
      } catch {
        // Not in Electron (tests/dev) — fall back to cwd.
      }
      const dir = path.join(userData, 'logs', 'profile-dumps');
      await fs.mkdir(dir, { recursive: true });

      // Keep only the most recent dumps (profile HTML is ~0.5 MB each). Each
      // profile now emits several pages (main + experience/education/contact
      // detail routes), so retain enough to capture a couple profiles' worth.
      const existing = (await fs.readdir(dir).catch(() => [] as string[]))
        .filter((f) => f.endsWith('.html'))
        .sort();
      for (let i = 0; i < existing.length - 12; i++) {
        const stale = existing[i];
        if (stale) await fs.unlink(path.join(dir, stale)).catch(() => {});
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${profileId}.html`);
      await fs.writeFile(file, html);
      logger.info('[scrape] dumped profile HTML for selector analysis', {
        phase: 'scrape',
        profileId,
        file,
        bytes: html.length,
      });
    } catch (error) {
      logger.debug('[scrape] profile HTML dump failed (non-fatal)', {
        phase: 'scrape',
        profileId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Scroll the profile down in bounded steps to trigger lazy-mounting of the
   * lower cards (Experience, Education, full Skills), then return to the top.
   * Best-effort and non-fatal; bounded by MAX_SCROLL_PX so it renders the
   * profile cards without walking into the infinite recommendation feed.
   */
  async _autoScroll() {
    try {
      await this.page.evaluate(
        async (maxPx: number, stepMs: number) => {
          const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const step = Math.max(600, Math.floor(window.innerHeight * 0.85));
          let scrolled = 0;
          let lastHeight = 0;
          while (scrolled < maxPx) {
            window.scrollBy(0, step);
            scrolled += step;
            await wait(stepMs);
            // Stop early once we've reached the current bottom and nothing more
            // is loading, so short profiles don't waste the full budget.
            const docHeight = document.documentElement.scrollHeight;
            if (window.scrollY + window.innerHeight >= docHeight - step) {
              if (docHeight === lastHeight) break;
              lastHeight = docHeight;
            }
          }
          window.scrollTo(0, 0);
        },
        MAX_SCROLL_PX,
        SCROLL_STEP_MS
      );
    } catch {
      // non-fatal — scrolling is a best-effort nudge to load lazy content
    }
  }

  /**
   * Wait briefly for lazy-loaded content to render.
   */
  async _settle() {
    return new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_MS));
  }
}
