import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createSeededRandom, seedFromString } from './seededRandom.js';
import { USER_AGENT_POOL } from '#utils/randomHelpers.js';
import { logger } from '#utils/logger.js';

export interface FingerprintProfile {
  version: number;
  createdAt: string;
  rotatedAt: string;
  rotationIntervalDays: number;
  seed: string;
  userAgent: string;
  gpuProfile: {
    vendor: string;
    renderer: string;
  };
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  screenResolution: {
    width: number;
    height: number;
  };
  platform: string;
  language: string;
  pluginCount: number;
}

export const GPU_PROFILES = [
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
];

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1600 },
];

function getOSFamily(ua: string): 'Windows' | 'Macintosh' | 'Linux' | 'Other' {
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Macintosh')) return 'Macintosh';
  if (ua.includes('Linux')) return 'Linux';
  return 'Other';
}

function getPlatformForUA(ua: string): string {
  if (ua.includes('Windows')) return 'Win32';
  if (ua.includes('Macintosh')) return 'MacIntel';
  if (ua.includes('Linux')) return 'Linux x86_64';
  return 'Win32';
}

export function generateFingerprintProfile(existing?: FingerprintProfile): FingerprintProfile {
  const seedBytes = crypto.randomBytes(32);
  const seedHex = seedBytes.toString('hex');
  const rng = createSeededRandom(seedFromString(seedHex));

  let uaPool = USER_AGENT_POOL;
  if (existing) {
    const oldFamily = getOSFamily(existing.userAgent);
    uaPool = USER_AGENT_POOL.filter((ua: string) => getOSFamily(ua) === oldFamily);
    if (uaPool.length === 0) uaPool = USER_AGENT_POOL;
  }

  const userAgent = uaPool[Math.floor(rng() * uaPool.length)]!;
  const gpuProfile = GPU_PROFILES[Math.floor(rng() * GPU_PROFILES.length)]!;
  const screenResolution = SCREEN_RESOLUTIONS[Math.floor(rng() * SCREEN_RESOLUTIONS.length)]!;
  const canvasNoiseSeed = Math.floor(rng() * 1000000);
  const audioNoiseSeed = Math.floor(rng() * 1000000);
  const pluginCount = Math.floor(rng() * 5) + 3; // 3-7

  const now = new Date().toISOString();

  return {
    version: 1,
    createdAt: existing ? existing.createdAt : now,
    rotatedAt: now,
    rotationIntervalDays: 30,
    seed: seedHex,
    userAgent,
    gpuProfile,
    canvasNoiseSeed,
    audioNoiseSeed,
    screenResolution,
    platform: getPlatformForUA(userAgent),
    language: 'en-US',
    pluginCount,
  };
}

export function rotateProfile(existing: FingerprintProfile): FingerprintProfile {
  const newProfile = generateFingerprintProfile(existing);
  const ageDays = Math.floor(
    (Date.now() - new Date(existing.rotatedAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  logger.info(
    `[FingerprintProfile] Rotated profile (age: ${ageDays} days, new seed: ${newProfile.seed.slice(0, 8)}...)`
  );
  return newProfile;
}

export function loadOrCreateProfile(profileDir: string): FingerprintProfile {
  const profilePath = path.join(profileDir, 'fingerprint-profile.json');

  if (fs.existsSync(profilePath)) {
    try {
      const data = fs.readFileSync(profilePath, 'utf8');
      const profile = JSON.parse(data) as FingerprintProfile;

      const rotatedAt = new Date(profile.rotatedAt).getTime();
      const now = Date.now();
      const daysSinceRotation = (now - rotatedAt) / (1000 * 60 * 60 * 24);

      if (daysSinceRotation > profile.rotationIntervalDays) {
        const rotated = rotateProfile(profile);
        saveProfile(profileDir, rotated);
        return rotated;
      }

      return profile;
    } catch (e) {
      logger.error(`[FingerprintProfile] Error loading profile: ${e}. Generating new one.`);
    }
  }

  const newProfile = generateFingerprintProfile();
  saveProfile(profileDir, newProfile);
  return newProfile;
}

function saveProfile(profileDir: string, profile: FingerprintProfile): void {
  try {
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    const profilePath = path.join(profileDir, 'fingerprint-profile.json');
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  } catch (e) {
    logger.error(`[FingerprintProfile] Error saving profile: ${e}`);
  }
}
