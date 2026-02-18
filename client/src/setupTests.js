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

// Mock axios for HTTP calls
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
  },
}));

// Helper to create mock Puppeteer page object
export function createMockPage(options = {}) {
  return {
    goto: vi.fn().mockResolvedValue(),
    waitForSelector: vi.fn().mockResolvedValue({
      click: vi.fn().mockResolvedValue(),
      type: vi.fn().mockResolvedValue(),
    }),
    click: vi.fn().mockResolvedValue(),
    type: vi.fn().mockResolvedValue(),
    evaluate: vi.fn().mockResolvedValue(options.evaluateResult || {}),
    $: vi.fn().mockResolvedValue(options.querySelector || null),
    $$: vi.fn().mockResolvedValue(options.querySelectorAll || []),
    waitForNavigation: vi.fn().mockResolvedValue(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    url: vi.fn().mockReturnValue(options.url || 'https://www.linkedin.com'),
    close: vi.fn().mockResolvedValue(),
    setViewport: vi.fn().mockResolvedValue(),
    setUserAgent: vi.fn().mockResolvedValue(),
  };
}

// Helper to create mock Puppeteer browser object
export function createMockBrowser() {
  return {
    newPage: vi.fn().mockResolvedValue(createMockPage()),
    close: vi.fn().mockResolvedValue(),
    pages: vi.fn().mockResolvedValue([]),
  };
}

// Helper to create mock profile data matching profileTextSchema
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
