import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PuppeteerService } from './puppeteerService';
import * as fingerprintProfile from '../utils/fingerprintProfile';
import config from '#shared-config/index.js';

vi.mock('puppeteer', () => ({
  default: {
    launch: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        setViewport: vi.fn().mockResolvedValue(undefined),
        setUserAgent: vi.fn().mockResolvedValue(undefined),
        setDefaultTimeout: vi.fn(),
        evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        setRequestInterception: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

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

  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(fingerprintProfile.loadOrCreateProfile).mockReturnValue(mockProfile as any);

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
    vi.mocked(fingerprintProfile.loadOrCreateProfile).mockImplementation(() => {
      throw new Error('No profile');
    });

    const page = await service.initialize();

    expect(page.setUserAgent).toHaveBeenCalled();
    expect(page.evaluateOnNewDocument).toHaveBeenCalledTimes(4); // 1 evasion + 3 noise
  });
});
