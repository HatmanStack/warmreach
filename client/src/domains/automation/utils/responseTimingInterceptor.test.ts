import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResponseTimingInterceptor } from './responseTimingInterceptor.ts';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('ResponseTimingInterceptor', () => {
  let interceptor: ResponseTimingInterceptor;
  let mockPage: any;
  let mockDetector: any;
  let callbacks: Record<string, Function> = {};

  beforeEach(() => {
    callbacks = {};
    mockPage = {
      on: vi.fn((event, cb) => {
        callbacks[event] = cb;
      }),
      off: vi.fn(),
    };
    mockDetector = {
      recordResponseTiming: vi.fn(),
      recordHttpStatus: vi.fn(),
    };
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
