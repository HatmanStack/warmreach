// @ts-nocheck -- migrated from .js; cheerio generic types need follow-up
/**
 * Local Profile Scraper
 *
 * Uses Puppeteer to navigate to LinkedIn profiles and extracts
 * structured data using cheerio CSS selectors against static HTML.
 */

import * as cheerio from 'cheerio';
import { logger } from '#utils/logger.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { profileSelectors } from '../selectors/profileSelectors.js';
import type { Page } from 'puppeteer';

type CheerioRoot = ReturnType<typeof cheerio.load>;
type CheerioNode = Parameters<Parameters<ReturnType<typeof cheerio.load>>[1]>[1];

const MAX_ACTIVITY_POSTS = 10;
const PAGE_SETTLE_MS = 2500;
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
    await this.page.goto(`https://www.linkedin.com/in/${profileId}/`, {
      waitUntil: 'networkidle2',
    });
    await this._settle();

    const profileHtml = await this.page.content();
    const $ = cheerio.load(profileHtml);

    // Extract profile fields
    const name = this._extractText($, 'profile:scrape-name');
    const headline = this._extractText($, 'profile:scrape-headline');
    const location = this._extractText($, 'profile:scrape-location');
    const about = this._extractText($, 'profile:scrape-about');
    const experience = this._extractExperience($);
    const education = this._extractEducation($);
    const skills = this._extractSkills($);

    // Derive current position from first experience entry
    const currentPosition = experience.length > 0 ? experience[0]! : null;

    if (!name) {
      logger.warn('No name found for profile', { profileId });
    }

    // Navigate to activity page (non-fatal)
    let recentActivity: ActivityEntry[] = [];
    try {
      await this.page.goto(`https://www.linkedin.com/in/${profileId}/recent-activity/all/`, {
        waitUntil: 'networkidle2',
      });
      await this._settle();

      const activityHtml = await this.page.content();
      const $activity = cheerio.load(activityHtml);
      recentActivity = this._extractActivity($activity);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to load activity page', {
        profileId,
        error: errMsg,
      });
    }

    return {
      name,
      headline,
      location,
      about,
      currentPosition,
      experience,
      education,
      skills,
      recentActivity,
    };
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
        logger.debug('Selector matched', { selectorKey, strategy });
        return result;
      }
    }

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
   * Extract experience entries from the experience section.
   */
  _extractExperience($: CheerioRoot): ExperienceEntry[] {
    const section = this._resolveSelector($, 'profile:scrape-experience-section');
    if (!section) return [];

    const items = this._resolveSelector(
      cheerio.load(section.html() || ''),
      'profile:scrape-experience-item'
    );
    if (!items) return [];

    const experiences: ExperienceEntry[] = [];
    items.each((_: number, el: CheerioNode) => {
      const $el = cheerio.load(el);
      experiences.push({
        company: this._extractSubField($el, 'profile:scrape-experience-company'),
        title: this._extractSubField($el, 'profile:scrape-experience-title'),
        dateRange: this._extractSubField($el, 'profile:scrape-experience-date'),
        description: this._extractSubField($el, 'profile:scrape-experience-description'),
      });
    });

    return experiences;
  }

  /**
   * Extract education entries from the education section.
   */
  _extractEducation($: CheerioRoot): EducationEntry[] {
    const section = this._resolveSelector($, 'profile:scrape-education-section');
    if (!section) return [];

    const items = this._resolveSelector(
      cheerio.load(section.html() || ''),
      'profile:scrape-education-item'
    );
    if (!items) return [];

    const entries: EducationEntry[] = [];
    items.each((_: number, el: CheerioNode) => {
      const $el = cheerio.load(el);
      entries.push({
        school: this._extractSubField($el, 'profile:scrape-education-school'),
        degree: this._extractSubField($el, 'profile:scrape-education-degree'),
        dateRange: this._extractSubField($el, 'profile:scrape-education-date'),
      });
    });

    return entries;
  }

  /**
   * Extract skill names from the skills section.
   */
  _extractSkills($: CheerioRoot): string[] {
    const section = this._resolveSelector($, 'profile:scrape-skills-section');
    if (!section) return [];

    const items = this._resolveSelector(
      cheerio.load(section.html() || ''),
      'profile:scrape-skill-item'
    );
    if (!items) return [];

    const skills: string[] = [];
    items.each((_: number, el: CheerioNode) => {
      const text = cheerio.load(el).text().trim();
      if (text) skills.push(text);
    });

    return skills;
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
    posts.each((i: number, el: CheerioNode) => {
      if (i >= MAX_ACTIVITY_POSTS) return;

      const $post = cheerio.load(el);
      const text = this._extractSubField($post, 'profile:scrape-activity-text');
      const timestamp = this._extractSubField($post, 'profile:scrape-activity-time');

      activities.push({ text, timestamp });
    });

    return activities;
  }

  /**
   * Wait briefly for lazy-loaded content to render.
   */
  async _settle() {
    return new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_MS));
  }
}
