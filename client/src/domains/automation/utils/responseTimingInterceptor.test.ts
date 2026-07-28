import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResponseTimingInterceptor } from './responseTimingInterceptor.js';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

/** Puppeteer page event handler captured from `page.on(event, handler)`. */
type PageEventHandler = (payload: unknown) => void;

/** The Page members ResponseTimingInterceptor attaches to. */
const makePage = (callbacks: Record<string, PageEventHandler>) => ({
  on: vi.fn((event: string, cb: PageEventHandler) => {
    callbacks[event] = cb;
  }),
  off: vi.fn(),
});

/** The SignalDetector members ResponseTimingInterceptor calls. */
const makeDetector = () => ({
  recordResponseTiming: vi.fn(),
  recordHttpStatus: vi.fn(),
});

describe('ResponseTimingInterceptor', () => {
  let interceptor: ResponseTimingInterceptor;
  let mockPage: ReturnType<typeof makePage>;
  let mockDetector: ReturnType<typeof makeDetector>;
  let callbacks: Record<string, PageEventHandler> = {};

  beforeEach(() => {
    callbacks = {};
    mockPage = makePage(callbacks);
    mockDetector = makeDetector();
    interceptor = new ResponseTimingInterceptor();
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches to page events', () => {
    interceptor.attachToPage(mockPage, mockDetector);
    expect(mockPage.on).toHaveBeenCalledWith('request', expect.any(Function));
    expect(mockPage.on).toHaveBeenCalledWith('response', expect.any(Function));
    expect(mockPage.on).toHaveBeenCalledWith('requestfailed', expect.any(Function));
  });

  it('records timing and status for LinkedIn requests', () => {
    interceptor.attachToPage(mockPage, mockDetector);

    const mockRequest = {
      url: () => 'https://www.linkedin.com/voyager/api/metadata',
    };

    const mockResponse = {
      url: () => 'https://www.linkedin.com/voyager/api/metadata',
      status: () => 200,
      request: () => mockRequest,
    };

    // Simulate request start
    callbacks['request'](mockRequest);

    // Advance time
    vi.advanceTimersByTime(250);

    // Simulate response
    callbacks['response'](mockResponse);

    expect(mockDetector.recordResponseTiming).toHaveBeenCalledWith(
      'https://www.linkedin.com/voyager/api/metadata',
      250
    );
    expect(mockDetector.recordHttpStatus).toHaveBeenCalledWith(
      'https://www.linkedin.com/voyager/api/metadata',
      200
    );
  });

  it('ignores non-LinkedIn requests', () => {
    interceptor.attachToPage(mockPage, mockDetector);

    const mockRequest = {
      url: () => 'https://google-analytics.com/collect',
    };

    callbacks['request'](mockRequest);
    expect(mockDetector.recordResponseTiming).not.toHaveBeenCalled();
  });

  it('ignores static assets', () => {
    interceptor.attachToPage(mockPage, mockDetector);

    const mockRequest = {
      url: () => 'https://static.licdn.com/sc/h/css-bundle.css',
    };

    callbacks['request'](mockRequest);
    expect(mockDetector.recordResponseTiming).not.toHaveBeenCalled();
  });

  it('cleans up pending requests on failure', () => {
    interceptor.attachToPage(mockPage, mockDetector);

    const mockRequest = {
      url: () => 'https://www.linkedin.com/api',
    };

    callbacks['request'](mockRequest);
    callbacks['requestfailed'](mockRequest);

    // Try to finish it anyway (should be ignored)
    const mockResponse = {
      url: () => 'https://www.linkedin.com/api',
      status: () => 0,
      request: () => mockRequest,
    };
    callbacks['response'](mockResponse);

    expect(mockDetector.recordResponseTiming).not.toHaveBeenCalled();
  });

  it('detaches from page events', () => {
    interceptor.attachToPage(mockPage, mockDetector);
    interceptor.detach();
    expect(mockPage.off).toHaveBeenCalledTimes(4);
  });
});
