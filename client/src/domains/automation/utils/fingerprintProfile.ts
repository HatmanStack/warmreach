import { readFile, writeFile, mkdir, access } from 'fs/promises';
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

export function getOSFamily(ua: string): 'Windows' | 'Macintosh' | 'Linux' | 'Other' {
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Macintosh')) return 'Macintosh';
  if (ua.includes('Linux')) return 'Linux';
  return 'Other';
}

function getBrowserFamily(ua: string): 'Chrome' | 'Firefox' | 'Edge' | 'Other' {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Chrome')) return 'Chrome';
  return 'Other';
}

// OS -> compatible GPU profile indices (based on GPU_PROFILES array)
// Windows: NVIDIA (0-2), AMD (3-4), Intel (5-6)
// Macintosh: Apple (7-8)
// Linux: Intel (5-6), AMD (3-4)
const OS_GPU_COMPAT: Record<string, number[]> = {
  Windows: [0, 1, 2, 3, 4, 5, 6],
  Macintosh: [7, 8],
  Linux: [3, 4, 5, 6],
};

// All UAs in the pool are desktop Chrome, so resolutions are desktop-class.
// Large resolutions (2560+) are more common on high-end desktops, smaller on laptops.
// Windows/Linux: all resolutions. Mac: prefer higher resolutions.
const OS_RESOLUTION_COMPAT: Record<string, number[]> = {
  Windows: [0, 1, 2, 3, 4, 5], // all
  Macintosh: [0, 1, 4, 5], // 1920x1080, 2560x1440, 1440x900, 2560x1600
  Linux: [0, 1, 2, 3], // 1920x1080, 2560x1440, 1366x768, 1536x864
};

// Browser -> plugin count range [min, max]
const BROWSER_PLUGIN_RANGE: Record<string, [number, number]> = {
  Chrome: [3, 7],
  Edge: [2, 5],
  Firefox: [1, 4],
  Other: [2, 5],
};

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

  // Step 1: Pick UA
  const userAgent = uaPool[Math.floor(rng() * uaPool.length)]!;
  const osFamily = getOSFamily(userAgent);
  const browserFamily = getBrowserFamily(userAgent);

  // Step 2: GPU constrained by OS family (fallback to full pool)
  const gpuIndices = OS_GPU_COMPAT[osFamily];
  const compatibleGpus = gpuIndices ? gpuIndices.map((i) => GPU_PROFILES[i]).filter(Boolean) : [];
  const gpuPool = compatibleGpus.length > 0 ? compatibleGpus : GPU_PROFILES;
  const gpuProfile = gpuPool[Math.floor(rng() * gpuPool.length)]!;

  // Step 3: Resolution constrained by OS family (fallback to full pool)
  const resIndices = OS_RESOLUTION_COMPAT[osFamily];
  const compatibleRes = resIndices
    ? resIndices.map((i) => SCREEN_RESOLUTIONS[i]).filter(Boolean)
    : [];
  const resPool = compatibleRes.length > 0 ? compatibleRes : SCREEN_RESOLUTIONS;
  const screenResolution = resPool[Math.floor(rng() * resPool.length)]!;

  // Step 4: Plugin count constrained by browser family
  const [pluginMin, pluginMax] =
    BROWSER_PLUGIN_RANGE[browserFamily] || BROWSER_PLUGIN_RANGE['Other']!;
  const pluginRange = pluginMax - pluginMin + 1;
  const pluginCount = Math.floor(rng() * pluginRange) + pluginMin;

  const canvasNoiseSeed = Math.floor(rng() * 1000000);
  const audioNoiseSeed = Math.floor(rng() * 1000000);

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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadOrCreateProfile(profileDir: string): Promise<FingerprintProfile> {
  const profilePath = path.join(profileDir, 'fingerprint-profile.json');

  if (await pathExists(profilePath)) {
    try {
      const data = await readFile(profilePath, 'utf8');
      const profile = JSON.parse(data) as FingerprintProfile;

      const rotatedAt = new Date(profile.rotatedAt).getTime();
      const now = Date.now();
      const daysSinceRotation = (now - rotatedAt) / (1000 * 60 * 60 * 24);

      if (daysSinceRotation > profile.rotationIntervalDays) {
        const rotated = rotateProfile(profile);
        await saveProfile(profileDir, rotated);
        return rotated;
      }

      return profile;
    } catch (e) {
      logger.error(`[FingerprintProfile] Error loading profile: ${e}. Generating new one.`);
    }
  }

  const newProfile = generateFingerprintProfile();
  await saveProfile(profileDir, newProfile);
  return newProfile;
}

async function saveProfile(profileDir: string, profile: FingerprintProfile): Promise<void> {
  try {
    if (!(await pathExists(profileDir))) {
      await mkdir(profileDir, { recursive: true });
    }
    const profilePath = path.join(profileDir, 'fingerprint-profile.json');
    await writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  } catch (e) {
    logger.error(`[FingerprintProfile] Error saving profile: ${e}`);
  }
}
