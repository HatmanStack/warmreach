import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { LocalProfileScraper } from './localProfileScraper.js';

// LinkedIn's 2026 profile is a Server-Driven-UI redesign: per-deploy hashed
// class names, no <h1>/JSON-LD/og: meta on the profile, and a name only
// reachable via the page <title>. The top card carries the headline in the
// aria-label-tagged name element; About/Skills are anchored by their heading
// text; and Experience/Education moved off the main page onto /details/
// sub-pages where each entry is an <a href="/company/…"> or /school/ anchor.

// Main profile page: name is read from page.title(), not the DOM.
const MAIN_PROFILE_HTML = `
<html><body>
  <nav>
    <!-- The viewer's own nav avatar: a profile-displayphoto, but the viewer's.
         The old list-page scrape mis-assigned this to every connection. -->
    <img fetchpriority="low" src="https://media.licdn.com/dms/image/v2/VIEWER/profile-displayphoto-shrink_100_100/0/1?e=1&v=beta&t=nav" />
  </nav>
  <main>
  <!-- A suggested/other member appears earlier in the DOM: their photo is
       linked to THEIR profile, so it must not be picked for Jane. -->
  <a href="https://www.linkedin.com/in/someone-else/">
    <img fetchpriority="low" alt="View Other Person’s profile" src="https://media.licdn.com/dms/image/v2/OTHER/profile-displayphoto-shrink_100_100/0/1?e=1&v=beta&t=other" />
  </a>
  <div aria-label="Jane Doe">
    <h1>Jane Doe</h1>
    <p>Senior Engineer at Acme</p>
    <!-- Cover photo: fetchpriority="high" but a displaybackgroundimage, excluded. -->
    <img fetchpriority="high" src="https://media.licdn.com/dms/image/v2/COVER/profile-displaybackgroundimage-shrink_200_800/0/1?e=1&v=beta&t=cover" />
    <!-- Jane's own top-card photo: wrapped in a link to her own profile, using
         the open-to-work framedphoto variant, carried on srcset only. -->
    <a href="https://www.linkedin.com/in/jane-doe/">
      <img fetchpriority="low" alt="View Jane Doe’s profile" srcset="https://media.licdn.com/dms/image/v2/OWN/profile-framedphoto-shrink_100_100/0/1?e=1&v=beta&t=own 1x" />
    </a>
  </div>
  <div class="top-card-subline">
    <p>San Francisco Bay Area</p>
    <p>·</p>
    <p><a href="https://www.linkedin.com/in/jane-doe/overlay/contact-info/">Contact info</a></p>
  </div>
  <section>
    <h2>About</h2>
    <div data-testid="expandable-text-box">Passionate about building great software.</div>
  </section>
  <section>
    <h2>Top skills</h2>
    <p>JavaScript • React • Node.js</p>
  </section>
</main></body></html>
`;

// Experience detail page. Includes a grouped multi-role company (Acme Corp
// prints its name once in a header anchor; each role beneath it omits the
// company and may carry a leading employment-type line) plus an ungrouped role
// (company on its own "Company · Type" line). This is exactly the shape that
// used to mis-parse the current role's company as a duration/employment-type.
const EXPERIENCE_DETAIL_HTML = `
<html><body><main>
  <div data-testid="profile_ExperienceDetailsSection_jane-doe">
    <a href="/company/100/"><span>Acme Corp</span><span>5 yrs</span></a>
    <a href="/company/100/"><span>Senior Engineer</span><span>Full-time</span><span>Jan 2022 - Present · 3 yrs</span><span>Remote</span></a>
    <a href="/company/100/"><span>Engineer</span><span>Jan 2020 - Jan 2022 · 2 yrs</span></a>
    <a href="/company/200/"><span>Junior Developer</span><span>Startup Inc · Full-time</span><span>2018 - 2020 · 2 yrs</span><span>San Francisco</span></a>
  </div>
</main></body></html>
`;

// Education detail page. Each school is a /school/ anchor: [School, Degree, date].
const EDUCATION_DETAIL_HTML = `
<html><body><main>
  <div data-testid="profile_EducationDetailsSection_jane-doe">
    <a href="/school/300/"><span>MIT</span><span>BS, Computer Science</span><span>2014 – 2018</span></a>
  </div>
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

// Fallback name path: no title (so _nameFromTitle returns null) and the name
// comes from the profileSelectors css cascade instead.
const MINIMAL_PROFILE_HTML = `
<html><body><main>
  <h1>John Smith</h1>
</main></body></html>
`;

const FALLBACK_ONLY_HTML = `
<html><body><main>
  <div class="ph5"><h1>Fallback Name</h1></div>
</main></body></html>
`;

describe('LocalProfileScraper', () => {
  let scraper;
  let mockPage;
  // Per-test fixtures, routed by the current page URL so the mock is robust to
  // how many navigations scrapeProfile makes (main + experience + education +
  // activity).
  let fixtures;

  beforeEach(() => {
    vi.clearAllMocks();
    fixtures = { main: '', expDetail: '', eduDetail: '', activity: '', title: '' };
    let currentUrl = '';
    mockPage = {
      goto: vi.fn().mockImplementation((url) => {
        currentUrl = url;
        return Promise.resolve();
      }),
      url: vi.fn().mockImplementation(() => currentUrl),
      title: vi.fn().mockImplementation(() => Promise.resolve(fixtures.title)),
      content: vi.fn().mockImplementation(() => {
        if (currentUrl.includes('details/experience')) return Promise.resolve(fixtures.expDetail);
        if (currentUrl.includes('details/education')) return Promise.resolve(fixtures.eduDetail);
        if (currentUrl.includes('recent-activity')) return Promise.resolve(fixtures.activity);
        return Promise.resolve(fixtures.main);
      }),
      evaluate: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
    };
    scraper = new LocalProfileScraper(mockPage);
    // _settle (a lazy-render wait) and _autoScroll (a lazy-mount scroll nudge)
    // are environmental timing helpers with no bearing on parsing. Against the
    // fully-rendered static HTML we inject there is nothing to wait for, so stub
    // them to no-ops and keep the tests free of real/fake-timer plumbing.
    scraper._settle = vi.fn().mockResolvedValue(undefined);
    scraper._autoScroll = vi.fn().mockResolvedValue(undefined);
  });

  it('should extract all fields from a full 2026 profile', async () => {
    fixtures.title = 'Jane Doe | LinkedIn';
    fixtures.main = MAIN_PROFILE_HTML;
    fixtures.expDetail = EXPERIENCE_DETAIL_HTML;
    fixtures.eduDetail = EDUCATION_DETAIL_HTML;
    fixtures.activity = ACTIVITY_HTML;

    const result = await scraper.scrapeProfile('jane-doe');

    expect(result.name).toBe('Jane Doe');
    expect(result.headline).toBe('Senior Engineer at Acme');
    // Location comes from the top card, anchored on the "· Contact info" link.
    expect(result.location).toBe('San Francisco Bay Area');
    expect(result.about).toBe('Passionate about building great software.');
    expect(result.skills).toEqual(['JavaScript', 'React', 'Node.js']);
    // Jane's own photo, resolved via the link to her own profile — not the
    // viewer's nav avatar, not another member's photo, not the cover image.
    expect(result.profilePictureUrl).toContain('/OWN/');
    expect(result.profilePictureUrl).not.toContain('VIEWER');
    expect(result.profilePictureUrl).not.toContain('OTHER');
    expect(result.profilePictureUrl).not.toContain('displaybackgroundimage');

    // Grouped company: the current role's company comes from the group header,
    // not the "5 yrs" tenure total or the "Full-time" employment-type line.
    expect(result.experience).toHaveLength(3);
    expect(result.experience[0]).toMatchObject({
      title: 'Senior Engineer',
      company: 'Acme Corp',
      dateRange: 'Jan 2022 - Present',
    });
    // Second grouped role also inherits the header company.
    expect(result.experience[1]).toMatchObject({ title: 'Engineer', company: 'Acme Corp' });
    // Ungrouped role: company parsed from its own "Company · Type" line.
    expect(result.experience[2]).toMatchObject({
      title: 'Junior Developer',
      company: 'Startup Inc',
    });
    expect(result.currentPosition).toMatchObject({
      title: 'Senior Engineer',
      company: 'Acme Corp',
    });

    expect(result.education).toHaveLength(1);
    expect(result.education[0]).toMatchObject({
      school: 'MIT',
      degree: 'BS, Computer Science',
      dateRange: '2014 – 2018',
    });

    expect(result.recentActivity).toHaveLength(2);

    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://www.linkedin.com/in/jane-doe/',
      expect.objectContaining({ waitUntil: 'networkidle2' })
    );
  });

  it('should return partial data when sections are missing', async () => {
    fixtures.title = ''; // no title → name falls back to the DOM cascade
    fixtures.main = MINIMAL_PROFILE_HTML;

    const result = await scraper.scrapeProfile('john-smith');

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
    fixtures.title = 'Jane Doe | LinkedIn';
    fixtures.main = MAIN_PROFILE_HTML;
    fixtures.activity = `<html><body>${posts}</body></html>`;

    const result = await scraper.scrapeProfile('jane-doe');

    expect(result.recentActivity).toHaveLength(10);
    expect(result.recentActivity[0].text).toBe('Post 1');
    expect(result.recentActivity[9].text).toBe('Post 10');
  });

  it('should return empty activity when activity page fails to load', async () => {
    fixtures.title = 'Jane Doe | LinkedIn';
    fixtures.main = MAIN_PROFILE_HTML;
    let currentUrl = '';
    mockPage.goto.mockImplementation((url) => {
      currentUrl = url;
      mockPage.url.mockReturnValue(currentUrl);
      return url.includes('recent-activity')
        ? Promise.reject(new Error('Navigation timeout'))
        : Promise.resolve();
    });

    const result = await scraper.scrapeProfile('jane-doe');

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
    fixtures.title = '';
    fixtures.main = MINIMAL_PROFILE_HTML;

    const result = await scraper.scrapeProfile('ali_hassan.doe~123');
    expect(result.name).toBe('John Smith');
  });

  it('should use the DOM name cascade when the page title has no name', async () => {
    fixtures.title = '';
    fixtures.main = FALLBACK_ONLY_HTML;

    const result = await scraper.scrapeProfile('fallback-test');

    expect(result.name).toBe('Fallback Name');
  });
});
