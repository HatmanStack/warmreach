import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  generateFingerprintProfile,
  loadOrCreateProfile,
  rotateProfile,
} from './fingerprintProfile';

vi.mock('fs');
vi.mock('crypto', async () => {
  const actual = (await vi.importActual('crypto')) as any;
  return {
    ...actual,
    randomBytes: vi.fn().mockImplementation((size) => {
      const buf = Buffer.alloc(size);
      for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
      return buf;
    }),
  };
});

describe('fingerprintProfile', () => {
  const mockProfileDir = '/mock/dir';
  const mockProfilePath = path.join(mockProfileDir, 'fingerprint-profile.json');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateFingerprintProfile', () => {
    it('produces a valid profile with all fields populated', () => {
      const profile = generateFingerprintProfile();
      expect(profile.version).toBe(1);
      expect(profile.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(profile.rotatedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(profile.seed).toHaveLength(64); // hex-encoded 32 bytes
      expect(profile.userAgent).toContain('Chrome');
      expect(profile.gpuProfile).toHaveProperty('vendor');
      expect(profile.gpuProfile).toHaveProperty('renderer');
      expect(profile.canvasNoiseSeed).toBeTypeOf('number');
      expect(profile.audioNoiseSeed).toBeTypeOf('number');
      expect(profile.screenResolution).toHaveProperty('width');
      expect(profile.screenResolution).toHaveProperty('height');
      expect(profile.platform).toBeDefined();
      expect(profile.language).toBe('en-US');
      expect(profile.pluginCount).toBeGreaterThanOrEqual(3);
      expect(profile.pluginCount).toBeLessThanOrEqual(7);
    });

    it('is deterministic for the same seed', () => {
      const fixedSeed = Buffer.alloc(32, 1);
      vi.mocked(crypto.randomBytes).mockReturnValue(fixedSeed as any);

      const profile1 = generateFingerprintProfile();

      vi.mocked(crypto.randomBytes).mockReturnValue(fixedSeed as any);
      const profile2 = generateFingerprintProfile();

      expect(profile1).toEqual(profile2);
    });
  });

  describe('loadOrCreateProfile', () => {
    it('creates and saves a new profile if none exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const profile = loadOrCreateProfile(mockProfileDir);

      expect(fs.existsSync).toHaveBeenCalledWith(mockProfilePath);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(profile.version).toBe(1);
    });

    it('loads an existing profile if it exists and is not due for rotation', () => {
      const existingProfile = generateFingerprintProfile();

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existingProfile));

      const profile = loadOrCreateProfile(mockProfileDir);

      expect(profile.seed).toBe(existingProfile.seed);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rotates the profile if it is expired', () => {
      const expiredDate = new Date('2025-11-01T00:00:00Z');

      const existingProfile = generateFingerprintProfile();
      existingProfile.rotatedAt = expiredDate.toISOString();
      const oldSeed = existingProfile.seed;

      // Mock rotation generating a DIFFERENT seed
      const newSeed = Buffer.alloc(32, 2);
      vi.mocked(crypto.randomBytes).mockReturnValue(newSeed as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existingProfile));

      const profile = loadOrCreateProfile(mockProfileDir);

      expect(profile.seed).not.toBe(oldSeed);
      expect(profile.rotatedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('rotateProfile', () => {
    it('maintains the OS family during rotation', () => {
      // Windows profile
      const winProfile = generateFingerprintProfile();
      winProfile.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...';
      winProfile.platform = 'Win32';

      const rotated = rotateProfile(winProfile);
      expect(rotated.userAgent).toContain('Windows');
      expect(rotated.platform).toBe('Win32');

      // Mac profile
      const macProfile = generateFingerprintProfile();
      macProfile.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...';
      macProfile.platform = 'MacIntel';

      const rotatedMac = rotateProfile(macProfile);
      expect(rotatedMac.userAgent).toContain('Macintosh');
      expect(rotatedMac.platform).toBe('MacIntel');
    });
  });

  describe('Platform consistency', () => {
    it('matches platform to user agent for many profiles', () => {
      for (let i = 0; i < 50; i++) {
        const profile = generateFingerprintProfile();
        if (profile.userAgent.includes('Windows')) {
          expect(profile.platform).toBe('Win32');
        } else if (profile.userAgent.includes('Macintosh')) {
          expect(profile.platform).toBe('MacIntel');
        } else if (profile.userAgent.includes('Linux')) {
          expect(profile.platform).toBe('Linux x86_64');
        }
      }
    });
  });
});
