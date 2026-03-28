import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { LocalProfileScraper } from './localProfileScraper.js';

// HTML fixtures matching the css-fallback selectors from profileSelectors.ts
const FULL_PROFILE_HTML = `
<html><body><main>
  <section class="top-card">
    <h1>Jane Doe</h1>
    <div class="text-body-medium">Software Engineer at Acme</div>
    <div class="text-body-small inline">San Francisco, CA</div>
  </section>
  <section aria-label="About">
    <div class="inline-show-more-text">Passionate about building great software.</div>
  </section>
  <section aria-label="Experience">
    <ul>
      <li class="artdeco-list__item">
        <span aria-hidden="true">Senior Engineer</span>
        <span class="t-normal">Acme Corp</span>
        <span class="t-black--light"><span aria-hidden="true">2020 - Present</span></span>
        <div class="inline-show-more-text">Leading frontend team.</div>
      </li>
      <li class="artdeco-list__item">
        <span aria-hidden="true">Junior Developer</span>
        <span class="t-normal">Startup Inc</span>
        <span class="t-black--light"><span aria-hidden="true">2018 - 2020</span></span>
        <div class="inline-show-more-text">Built APIs.</div>
      </li>
    </ul>
  </section>
  <section aria-label="Education">
    <ul>
      <li class="artdeco-list__item">
        <span aria-hidden="true">MIT</span>
        <span class="t-normal">BS Computer Science</span>
        <span class="t-black--light"><span aria-hidden="true">2014 - 2018</span></span>
      </li>
    </ul>
  </section>
  <section aria-label="Skills">
    <ul>
      <li class="artdeco-list__item"><span aria-hidden="true">JavaScript</span></li>
      <li class="artdeco-list__item"><span aria-hidden="true">React</span></li>
      <li class="artdeco-list__item"><span aria-hidden="true">Node.js</span></li>
    </ul>
  </section>
</main></body></html>
`;

const ACTIVITY_HTML = `
<html><body>
  <div class="feed-shared-update-v2">
    <div class="feed-shared-text"><span class="break-words">Excited to share my new project!</span></div>
    <time class="feed-shared-actor__sub-description">2 days ago</time>
  </div>
  <div class="feed-shared-update-v2">
    <div class="feed-shared-text"><span class="break-words">Great article on distributed systems.</span></div>
    <time class="feed-shared-actor__sub-description">1 week ago</time>
  </div>
</body></html>
`;

const MINIMAL_PROFILE_HTML = `
<html><body><main>
  <h1>John Smith</h1>
</main></body></html>
`;

// HTML where only the fallback selector matches (not the primary one)
const FALLBACK_ONLY_HTML = `
<html><body><main>
  <div class="ph5"><h1>Fallback Name</h1></div>
</main></body></html>
`;

describe('LocalProfileScraper', () => {
  let scraper;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn(),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
    };
    scraper = new LocalProfileScraper(mockPage);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to advance fake timers while awaiting an async operation
  async function runWithTimers(promise) {
    const result = promise;
    await vi.advanceTimersByTimeAsync(10000);
    return result;
  }

  it('should extract all fields from a full profile', async () => {
    mockPage.content.mockResolvedValueOnce(FULL_PROFILE_HTML).mockResolvedValueOnce(ACTIVITY_HTML);

    const result = await runWithTimers(scraper.scrapeProfile('jane-doe'));

    expect(result.name).toBe('Jane Doe');
    expect(result.headline).toBe('Software Engineer at Acme');
    expect(result.location).toBe('San Francisco, CA');
    expect(result.about).toBe('Passionate about building great software.');
    expect(result.experience).toHaveLength(2);
    expect(result.experience[0].title).toBe('Senior Engineer');
    expect(result.experience[0].company).toBe('Acme Corp');
    expect(result.experience[0].dateRange).toBe('2020 - Present');
    expect(result.experience[0].description).toBe('Leading frontend team.');
    expect(result.experience[1].title).toBe('Junior Developer');
    expect(result.experience[1].company).toBe('Startup Inc');
    expect(result.education).toHaveLength(1);
    expect(result.education[0].school).toBe('MIT');
    expect(result.education[0].degree).toBe('BS Computer Science');
    expect(result.education[0].dateRange).toBe('2014 - 2018');
    expect(result.skills).toHaveLength(3);
    expect(result.skills).toContain('JavaScript');
    expect(result.recentActivity).toHaveLength(2);

    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://www.linkedin.com/in/jane-doe/',
      expect.objectContaining({ waitUntil: 'networkidle2' })
    );
  });

  it('should return partial data when sections are missing', async () => {
    mockPage.content
      .mockResolvedValueOnce(MINIMAL_PROFILE_HTML)
      .mockResolvedValueOnce('<html><body></body></html>');

    const result = await runWithTimers(scraper.scrapeProfile('john-smith'));

    expect(result.name).toBe('John Smith');
    expect(result.headline).toBeNull();
    expect(result.location).toBeNull();
    expect(result.about).toBeNull();
    expect(result.experience).toEqual([]);
    expect(result.education).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.recentActivity).toEqual([]);
  });

  it('should extract activity posts and cap at 10', async () => {
    const posts = Array.from(
      { length: 12 },
      (_, i) => `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-text"><span class="break-words">Post ${i + 1}</span></div>
        <time class="feed-shared-actor__sub-description">${i + 1} days ago</time>
      </div>`
    ).join('');
    const manyActivityHtml = `<html><body>${posts}</body></html>`;

    mockPage.content
      .mockResolvedValueOnce(FULL_PROFILE_HTML)
      .mockResolvedValueOnce(manyActivityHtml);

    const result = await runWithTimers(scraper.scrapeProfile('jane-doe'));

    expect(result.recentActivity).toHaveLength(10);
    expect(result.recentActivity[0].text).toBe('Post 1');
    expect(result.recentActivity[9].text).toBe('Post 10');
  });

  it('should return empty activity when activity page fails to load', async () => {
    mockPage.content.mockResolvedValueOnce(FULL_PROFILE_HTML);
    mockPage.goto
      .mockResolvedValueOnce(undefined) // profile page succeeds
      .mockRejectedValueOnce(new Error('Navigation timeout')); // activity page fails

    const result = await runWithTimers(scraper.scrapeProfile('jane-doe'));

    expect(result.name).toBe('Jane Doe');
    expect(result.recentActivity).toEqual([]);
  });

  it('should throw when profile page navigation fails', async () => {
    mockPage.goto.mockRejectedValue(new Error('ERR_CONNECTION_REFUSED'));

    await expect(scraper.scrapeProfile('bad-profile')).rejects.toThrow('ERR_CONNECTION_REFUSED');
  });

  it('should reject invalid profile IDs with LinkedInError', async () => {
    const err1 = scraper.scrapeProfile('../../evil');
    await expect(err1).rejects.toThrow('Invalid profile ID');
    await expect(err1).rejects.toHaveProperty('code', 'INVALID_PROFILE_ID');

    await expect(scraper.scrapeProfile('foo?bar=1')).rejects.toThrow('Invalid profile ID');
    await expect(scraper.scrapeProfile('')).rejects.toThrow('Invalid profile ID');
  });

  it('should accept valid profile IDs with dots, underscores, and tildes', async () => {
    mockPage.content
      .mockResolvedValueOnce(MINIMAL_PROFILE_HTML)
      .mockResolvedValueOnce('<html><body></body></html>');

    const result = await runWithTimers(scraper.scrapeProfile('ali_hassan.doe~123'));
    expect(result.name).toBe('John Smith');
  });

  it('should use fallback selector when primary does not match', async () => {
    mockPage.content
      .mockResolvedValueOnce(FALLBACK_ONLY_HTML)
      .mockResolvedValueOnce('<html><body></body></html>');

    const result = await runWithTimers(scraper.scrapeProfile('fallback-test'));

    expect(result.name).toBe('Fallback Name');
  });
});
