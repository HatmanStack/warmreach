import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  extractLinkedInCookies,
  serializeCookies,
  hasValidLinkedInSession,
} from './cookieExtractor.js';

// Mock logger to avoid file system operations during tests
vi.mock('#utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
  default: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock page object factory
function createMockPage(cookies: Array<{ name: string; value: string; domain: string }>) {
  return {
    cookies: vi.fn().mockResolvedValue(cookies),
  } as unknown;
}

describe('cookieExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractLinkedInCookies', () => {
    it('should extract and serialize LinkedIn cookies', async () => {
      const mockPage = createMockPage([
        { name: 'li_at', value: 'auth-token-123', domain: '.linkedin.com' },
        { name: 'JSESSIONID', value: 'session-456', domain: 'www.linkedin.com' },
        { name: 'other', value: 'ignored', domain: '.google.com' },
      ]);

      const result = await extractLinkedInCookies(mockPage as any);

      expect(result).toBe('li_at=auth-token-123; JSESSIONID=session-456');
    });

    it('should throw if no LinkedIn cookies found', async () => {
      const mockPage = createMockPage([{ name: 'other', value: 'value', domain: '.google.com' }]);

      await expect(extractLinkedInCookies(mockPage as any)).rejects.toThrow(
        /no linkedin cookies found/i
      );
    });

    it('should throw if cookies array is empty', async () => {
      const mockPage = createMockPage([]);

      await expect(extractLinkedInCookies(mockPage as any)).rejects.toThrow(
        /no linkedin cookies found/i
      );
    });

    it('should include all LinkedIn domain cookies', async () => {
      const mockPage = createMockPage([
        { name: 'li_at', value: 'token', domain: '.linkedin.com' },
        { name: 'liap', value: 'true', domain: 'www.linkedin.com' },
        { name: 'li_rm', value: 'remember', domain: 'linkedin.com' },
      ]);

      const result = await extractLinkedInCookies(mockPage as any);

      expect(result).toContain('li_at=token');
      expect(result).toContain('liap=true');
      expect(result).toContain('li_rm=remember');
    });

    it('should handle cookies with special characters in values', async () => {
      const mockPage = createMockPage([
        { name: 'li_at', value: 'AQE=xyz;123', domain: '.linkedin.com' },
      ]);

      const result = await extractLinkedInCookies(mockPage as any);

      expect(result).toBe('li_at=AQE=xyz;123');
    });

    it('should filter out non-LinkedIn cookies', async () => {
      const mockPage = createMockPage([
        { name: 'li_at', value: 'token', domain: '.linkedin.com' },
        { name: 'facebook_token', value: 'fb', domain: '.facebook.com' },
        { name: 'google_token', value: 'g', domain: '.google.com' },
      ]);

      const result = await extractLinkedInCookies(mockPage as any);

      expect(result).toBe('li_at=token');
      expect(result).not.toContain('facebook');
      expect(result).not.toContain('google');
    });
  });

  describe('serializeCookies', () => {
    it('should serialize cookies to standard format', () => {
      const cookies = [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ] as any;

      expect(serializeCookies(cookies)).toBe('a=1; b=2');
    });

    it('should handle single cookie', () => {
      const cookies = [{ name: 'single', value: 'cookie' }] as any;

      expect(serializeCookies(cookies)).toBe('single=cookie');
    });

    it('should handle empty array', () => {
      expect(serializeCookies([])).toBe('');
    });

    it('should preserve cookie values exactly', () => {
      const cookies = [
        { name: 'token', value: 'a=b=c' },
        { name: 'session', value: 'ajax:12345' },
      ] as any;

      expect(serializeCookies(cookies)).toBe('token=a=b=c; session=ajax:12345');
    });
  });

  describe('hasValidLinkedInSession', () => {
    it('should return true when li_at cookie present', async () => {
      const mockPage = createMockPage([{ name: 'li_at', value: 'token', domain: '.linkedin.com' }]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(true);
    });

    it('should return true when JSESSIONID present', async () => {
      const mockPage = createMockPage([
        { name: 'JSESSIONID', value: 'session', domain: '.linkedin.com' },
      ]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(true);
    });

    it('should return true when liap present', async () => {
      const mockPage = createMockPage([{ name: 'liap', value: 'true', domain: '.linkedin.com' }]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(true);
    });

    it('should return true when li_rm present', async () => {
      const mockPage = createMockPage([
        { name: 'li_rm', value: 'remember', domain: '.linkedin.com' },
      ]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(true);
    });

    it('should return false when no auth cookies', async () => {
      const mockPage = createMockPage([
        { name: 'tracking', value: 'id', domain: '.linkedin.com' },
        { name: 'lang', value: 'en', domain: '.linkedin.com' },
      ]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(false);
    });

    it('should return false when LinkedIn cookies are from wrong domain', async () => {
      const mockPage = createMockPage([
        { name: 'li_at', value: 'token', domain: '.notlinkedin.com' },
      ]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(false);
    });

    it('should return false on error', async () => {
      const mockPage = {
        cookies: vi.fn().mockRejectedValue(new Error('Browser closed')),
      };

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(false);
    });

    it('should return false on empty cookies array', async () => {
      const mockPage = createMockPage([]);

      expect(await hasValidLinkedInSession(mockPage as any)).toBe(false);
    });
  });
});
