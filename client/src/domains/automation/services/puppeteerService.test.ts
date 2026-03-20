import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PuppeteerService } from './puppeteerService';
import * as fingerprintProfile from '../utils/fingerprintProfile';
import config from '#shared-config/index.js';

const mockPage = {
  setViewport: vi.fn(),
  setUserAgent: vi.fn(),
  setDefaultTimeout: vi.fn(),
  evaluateOnNewDocument: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  setRequestInterception: vi.fn(),
};

const mockBrowser = {
  newPage: vi.fn(),
  close: vi.fn(),
};

vi.mock('puppeteer', () => {
  return {
    default: {
      launch: vi.fn(),
    },
  };
});

vi.mock('../utils/fingerprintProfile', () => ({
  loadOrCreateProfile: vi.fn(),
  GPU_PROFILES: [{ vendor: 'MockVendor', renderer: 'MockRenderer' }],
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

vi.mock('#utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('PuppeteerService', () => {
  let service: PuppeteerService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockPage.setViewport.mockResolvedValue(undefined);
    mockPage.setUserAgent.mockResolvedValue(undefined);
    mockPage.evaluateOnNewDocument.mockResolvedValue(undefined);
    mockPage.setRequestInterception.mockResolvedValue(undefined);
    mockBrowser.newPage.mockResolvedValue(mockPage);
    mockBrowser.close.mockResolvedValue(undefined);

    const puppeteer = await import('puppeteer');
    vi.mocked(puppeteer.default.launch).mockResolvedValue(mockBrowser as any);

    service = new PuppeteerService();
    config.puppeteer.enableFingerprintNoise = true;
  });

  it('uses fingerprint profile if available', async () => {
    const mockProfile = {
      userAgent: 'Mock UA',
      canvasNoiseSeed: 123,
      audioNoiseSeed: 456,
      gpuProfile: { vendor: 'V', renderer: 'R' },
      platform: 'WinMock',
      language: 'en-Mock',
      pluginCount: 9,
      screenResolution: { width: 800, height: 600 },
      rotatedAt: new Date().toISOString(),
      rotationIntervalDays: 30,
    };
    vi.mocked(fingerprintProfile.loadOrCreateProfile).mockResolvedValue(mockProfile as any);

    const page = await service.initialize();

    expect(fingerprintProfile.loadOrCreateProfile).toHaveBeenCalled();
    expect(page.setUserAgent).toHaveBeenCalledWith('Mock UA');

    // Check if stealth scripts were called with profile data
    const evalCalls = vi.mocked(page.evaluateOnNewDocument).mock.calls;

    // Headless evasion
    expect(
      evalCalls.some((call) => call[0].includes('WinMock') && call[0].includes('en-Mock'))
    ).toBe(true);
    // Canvas
    expect(evalCalls.some((call) => call[0].includes('123'))).toBe(true);
    // WebGL
    expect(evalCalls.some((call) => call[0].includes('V') && call[0].includes('R'))).toBe(true);
    // Audio
    expect(evalCalls.some((call) => call[0].includes('456'))).toBe(true);
  });

  it('falls back to random behavior if no profile is available', async () => {
    vi.mocked(fingerprintProfile.loadOrCreateProfile).mockRejectedValue(new Error('No profile'));

    const page = await service.initialize();

    expect(page.setUserAgent).toHaveBeenCalled();
    expect(page.evaluateOnNewDocument).toHaveBeenCalledTimes(4); // 1 evasion + 3 noise
  });

  describe('close() listener cleanup', () => {
    it('removes all three event listeners via page.off()', async () => {
      vi.mocked(fingerprintProfile.loadOrCreateProfile).mockImplementation(() => {
        throw new Error('No profile');
      });

      await service.initialize();
      await service.close();

      // Verify page.off was called for console and pageerror (request only if interception enabled)
      const offCalls = vi.mocked(mockPage.off).mock.calls;
      const offEvents = offCalls.map((call) => call[0]);

      expect(offEvents).toContain('console');
      expect(offEvents).toContain('pageerror');
    });

    it('removes request listener when request interception is enabled', async () => {
      vi.mocked(fingerprintProfile.loadOrCreateProfile).mockImplementation(() => {
        throw new Error('No profile');
      });
      config.puppeteer.enableRequestInterception = true;

      await service.initialize();
      await service.close();

      const offCalls = vi.mocked(mockPage.off).mock.calls;
      const offEvents = offCalls.map((call) => call[0]);

      expect(offEvents).toContain('request');
      expect(offEvents).toContain('console');
      expect(offEvents).toContain('pageerror');
    });

    it('does not call page.removeAllListeners()', async () => {
      vi.mocked(fingerprintProfile.loadOrCreateProfile).mockImplementation(() => {
        throw new Error('No profile');
      });

      await service.initialize();

      // Add removeAllListeners mock to verify it's NOT called
      (mockPage as any).removeAllListeners = vi.fn();

      await service.close();

      expect((mockPage as any).removeAllListeners).not.toHaveBeenCalled();
    });

    it('passes the stored handler reference to page.off()', async () => {
      vi.mocked(fingerprintProfile.loadOrCreateProfile).mockImplementation(() => {
        throw new Error('No profile');
      });

      await service.initialize();

      // Capture the handlers that were registered with page.on()
      const onCalls = vi.mocked(mockPage.on).mock.calls;
      const consoleHandler = onCalls.find((call) => call[0] === 'console')?.[1];
      const pageerrorHandler = onCalls.find((call) => call[0] === 'pageerror')?.[1];

      await service.close();

      // Verify page.off was called with the same handler references
      const offCalls = vi.mocked(mockPage.off).mock.calls;
      const consoleOff = offCalls.find((call) => call[0] === 'console');
      const pageerrorOff = offCalls.find((call) => call[0] === 'pageerror');

      expect(consoleOff?.[1]).toBe(consoleHandler);
      expect(pageerrorOff?.[1]).toBe(pageerrorHandler);
    });
  });
});
