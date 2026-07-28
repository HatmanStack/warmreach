import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSignalAnalyzer } from './contentSignalAnalyzer.js';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

/** The Page members ContentSignalAnalyzer calls. */
const makePage = () => ({
  url: vi.fn(() => 'https://www.linkedin.com/feed/'),
  evaluate: vi.fn(() => null),
});

/** The SignalDetector members ContentSignalAnalyzer calls. */
const makeDetector = () => ({
  recordContentSignal: vi.fn(),
});

/** The SelectorResolver members ContentSignalAnalyzer calls. */
const makeResolver = () => ({
  resolve: vi.fn(),
  resolveAll: vi.fn(),
});

describe('ContentSignalAnalyzer', () => {
  let analyzer: ContentSignalAnalyzer;
  let mockPage: ReturnType<typeof makePage>;
  let mockDetector: ReturnType<typeof makeDetector>;
  let mockResolver: ReturnType<typeof makeResolver>;

  beforeEach(() => {
    mockPage = makePage();
    mockDetector = makeDetector();
    mockResolver = makeResolver();
    analyzer = new ContentSignalAnalyzer(
      mockResolver as unknown as ConstructorParameters<typeof ContentSignalAnalyzer>[0]
    );
  });

  it('detects checkpoint URLs', async () => {
    mockPage.url.mockReturnValue('https://www.linkedin.com/checkpoint/challenge/123');
    await analyzer.analyzePage(mockPage, mockDetector);
    expect(mockDetector.recordContentSignal).toHaveBeenCalledWith(
      'checkpoint-detected',
      expect.any(String)
    );
  });

  it('detects unexpected login redirects', async () => {
    mockPage.url.mockReturnValue('https://www.linkedin.com/login?from=... ');
    await analyzer.analyzePage(mockPage, mockDetector, { action: 'search' });
    expect(mockDetector.recordContentSignal).toHaveBeenCalledWith(
      'login-redirect',
      expect.any(String)
    );
  });

  it('ignores expected login redirects', async () => {
    mockPage.url.mockReturnValue('https://www.linkedin.com/login');
    await analyzer.analyzePage(mockPage, mockDetector, { action: 'login' });
    expect(mockDetector.recordContentSignal).not.toHaveBeenCalledWith(
      'login-redirect',
      expect.any(String)
    );
  });

  it('detects restriction banners', async () => {
    mockPage.evaluate.mockResolvedValue('unusual activity');
    await analyzer.analyzePage(mockPage, mockDetector);
    expect(mockDetector.recordContentSignal).toHaveBeenCalledWith(
      'unusual-activity-banner',
      'unusual activity'
    );
  });

  it('detects empty search results when expected', async () => {
    mockPage.url.mockReturnValue('https://www.linkedin.com/search/results/people/...');
    mockResolver.resolveAll.mockResolvedValue([]); // No results
    await analyzer.analyzePage(mockPage, mockDetector, { expectedContent: 'search-results' });
    expect(mockDetector.recordContentSignal).toHaveBeenCalledWith(
      'empty-results',
      expect.any(String)
    );
  });

  it('detects missing profile indicators when expected', async () => {
    mockResolver.resolve.mockResolvedValue(null); // Not found
    await analyzer.analyzePage(mockPage, mockDetector, { expectedContent: 'profile' });
    expect(mockDetector.recordContentSignal).toHaveBeenCalledWith(
      'missing-dom-elements',
      expect.any(String)
    );
  });
});
