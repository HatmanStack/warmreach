/**
 * Vitest setup file - common mocks and test utilities
 */

import { vi } from 'vitest';

// Mock logger to suppress output during tests
vi.mock('./shared/utils/logger.js', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { default: logger, logger };
});

// Mock fetch for HTTP calls
vi.stubGlobal(
  'fetch',
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })
  )
);

/**
 * Helper to create a mock Puppeteer page object.
 *
 * The double implements only the members the code under test calls; use
 * `asPuppeteerPage` from `src/test-utils/mocks.ts` to hand it to something
 * declaring a real `Page`.
 *
 * @param {{ evaluateResult?: unknown, querySelector?: unknown, querySelectorAll?: unknown[], url?: string }} [options]
 */
export function createMockPage(options = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue({
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 80, height: 30 }),
    }),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(options.evaluateResult || {}),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue(options.querySelector || null),
    $$: vi.fn().mockResolvedValue(options.querySelectorAll || []),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    url: vi.fn().mockReturnValue(options.url || 'https://www.linkedin.com'),
    close: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    setDefaultTimeout: vi.fn(),
    isClosed: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// Helper to create mock Puppeteer browser object
export function createMockBrowser() {
  return {
    newPage: vi.fn().mockResolvedValue(createMockPage()),
    close: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([]),
    isConnected: vi.fn().mockReturnValue(true),
  };
}

/**
 * Helper to create mock profile data matching the scraped-profile shape.
 * @param {Record<string, unknown>} [overrides]
 */
export function createMockProfile(overrides = {}) {
  return {
    profile_id: 'dGVzdC1wcm9maWxlLTEyMw==',
    url: 'https://www.linkedin.com/in/test-profile-123/',
    name: 'Test User',
    headline: 'Software Engineer at Test Company',
    location: 'San Francisco, CA',
    current_position: {
      company: 'Test Company',
      title: 'Software Engineer',
      employment_type: 'Full-time',
      start_date: '2022-01',
      end_date: 'Present',
      description: 'Building awesome software',
    },
    experience: [
      {
        company: 'Previous Company',
        title: 'Junior Developer',
        employment_type: 'Full-time',
        start_date: '2020-06',
        end_date: '2021-12',
        description: 'Worked on web applications',
      },
    ],
    education: [
      {
        school: 'Test University',
        degree: 'Bachelor of Science',
        field_of_study: 'Computer Science',
        start_date: '2016',
        end_date: '2020',
        description: null,
      },
    ],
    skills: ['JavaScript', 'Python', 'React', 'Node.js'],
    about: 'Passionate software engineer with experience in web development.',
    fulltext: '',
    extracted_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}
