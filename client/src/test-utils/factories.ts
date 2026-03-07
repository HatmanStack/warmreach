import { vi } from 'vitest';

interface LinkedInProfile {
  profileId: string;
  firstName: string;
  lastName: string;
  headline: string;
  location: string;
  summary: string;
  connectionCount: number;
  industry: string;
}

interface LinkedInCookie {
  name: string;
  value: string;
  domain: string;
}

interface JwtPayload {
  sub?: string;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Factory for creating mock LinkedIn profile objects.
 */
export function buildLinkedInProfile(overrides: Partial<LinkedInProfile> = {}): LinkedInProfile {
  return {
    profileId: 'john-doe',
    firstName: 'John',
    lastName: 'Doe',
    headline: 'Software Engineer at TechCorp',
    location: 'San Francisco, California',
    summary: 'Experienced developer with a passion for building scalable systems.',
    connectionCount: 500,
    industry: 'Computer Software',
    ...overrides,
  };
}

/**
 * Factory for creating mock LinkedIn cookie arrays.
 */
export function buildCookieSet(
  overrides: Record<string, string> | LinkedInCookie[] = {}
): LinkedInCookie[] {
  const defaultCookies: LinkedInCookie[] = [
    { name: 'li_at', value: 'mock-li-at-token', domain: '.www.linkedin.com' },
    { name: 'JSESSIONID', value: 'ajax:1234567890', domain: '.www.linkedin.com' },
    { name: 'li_rm', value: 'mock-li-rm-token', domain: '.www.linkedin.com' },
  ];

  if (Array.isArray(overrides)) {
    return overrides;
  }

  return defaultCookies.map((cookie) => {
    const override = overrides[cookie.name];
    if (override) {
      return { ...cookie, value: override };
    }
    return cookie;
  });
}

/**
 * Factory for creating mock JWT tokens.
 */
export function buildJwtToken(payload: JwtPayload = {}, signature = 'test-signature') {
  let finalPayload = { ...payload };

  // If payload is totally empty, use defaults
  if (Object.keys(payload).length === 0) {
    finalPayload = {
      sub: 'user-123',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(finalPayload)).toString('base64url');
  return `${header}.${payloadB64}.${signature}`;
}

export interface MockPuppeteerPage {
  goto: ReturnType<typeof vi.fn>;
  waitForSelector: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  evaluateOnNewDocument: ReturnType<typeof vi.fn>;
  $: ReturnType<typeof vi.fn>;
  $$: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  waitForNavigation: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  cookies: ReturnType<typeof vi.fn>;
  setViewport: ReturnType<typeof vi.fn>;
  setUserAgent: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  isClosed: ReturnType<typeof vi.fn>;
  [key: string]: ReturnType<typeof vi.fn>;
}

/**
 * Factory for creating mock Puppeteer page objects.
 */
export function buildPuppeteerPage(overrides: Partial<MockPuppeteerPage> = {}): MockPuppeteerPage {
  return {
    goto: vi.fn().mockResolvedValue({ ok: () => true }),
    waitForSelector: vi.fn().mockResolvedValue(true),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue({ click: vi.fn() }),
    $$: vi.fn().mockResolvedValue([]),
    type: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://www.linkedin.com/feed/'),
    cookies: vi.fn().mockResolvedValue([]),
    setViewport: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    isClosed: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

interface WebSocketCommand {
  commandId: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Factory for creating mock WebSocket command objects.
 */
export function buildCommand(overrides: Partial<WebSocketCommand> = {}): WebSocketCommand {
  return {
    commandId: 'cmd-123',
    type: 'linkedin:search',
    payload: {
      query: 'software engineer',
    },
    ...overrides,
  };
}

interface ScrapeResult {
  jobId: string;
  status: string;
  processedCount: number;
  totalUrls: number;
  failedCount: number;
  data: { profileId: string; content: string };
}

/**
 * Factory for creating mock RAGStack scrape results.
 */
export function buildScrapeResult(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    jobId: 'job-123',
    status: 'COMPLETED',
    processedCount: 1,
    totalUrls: 1,
    failedCount: 0,
    data: {
      profileId: 'john-doe',
      content: 'Profile content here...',
    },
    ...overrides,
  };
}

interface BrowserSession {
  isActive: boolean;
  isHealthy: boolean;
  isAuthenticated: boolean;
  lastActivity: string;
  sessionAge: number;
  errorCount: number;
}

/**
 * Factory for creating mock browser session state.
 */
export function buildBrowserSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    isActive: true,
    isHealthy: true,
    isAuthenticated: true,
    lastActivity: new Date().toISOString(),
    sessionAge: 3600,
    errorCount: 0,
    ...overrides,
  };
}

interface DynamoDBItem {
  PK: string;
  SK: string;
  [key: string]: unknown;
}

/**
 * Factory for creating mock DynamoDB items.
 */
export function buildDynamoDBItem(overrides: Partial<DynamoDBItem> = {}): DynamoDBItem {
  return {
    PK: 'USER#user-123',
    SK: 'PROFILE#john-doe',
    first_name: 'John',
    last_name: 'Doe',
    status: 'connected',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
