#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Launch a non-headless Puppeteer browser for manual LinkedIn fingerprint inspection.
 *
 * Usage:  node client/linkedin-inspect.mjs
 *
 * The browser opens with the full stealth mitigation stack active (stealth plugin +
 * canvas/WebGL/audio fingerprint noise, request interception, random user agent,
 * system Chrome detection), matching what PuppeteerService uses in production.
 * Close the browser window or press Ctrl-C to exit.
 *
 * Set PUPPETEER_STEALTH=false to disable stealth plugin for comparison testing.
 * Set PUPPETEER_FINGERPRINT_NOISE=false to disable canvas/WebGL/audio noise.
 */

import fs from 'fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
  getHeadlessEvasionScript,
} from './src/domains/automation/utils/stealthScripts.ts';
import { loadOrCreateProfile, GPU_PROFILES } from './src/domains/automation/utils/fingerprintProfile.ts';
import RandomHelpers from './src/shared/utils/randomHelpers.js';

const stealthEnabled = false; // Completely stripping puppeteer-extra-plugin-stealth
if (stealthEnabled) {
  const stealth = StealthPlugin();

  // LinkedIn is detecting one of the evasions. We will disable them one by one.
  // The most common triggers for advanced bot scripts are navigator.webdriver and chrome.runtime
  stealth.enabledEvasions.delete('chrome.runtime');
  stealth.enabledEvasions.delete('iframe.contentWindow');

  puppeteer.use(stealth);
  console.log('Stealth plugin enabled (Selective Evasion: chrome.runtime, iframe.contentWindow DISABLED)');
} else {
  console.log('Stealth plugin disabled (using Custom Evasion Scripts instead)');
}

// Detect system Chrome/Chromium (same logic as PuppeteerService)
function detectSystemChrome() {
  const configPath = process.env.CHROME_EXECUTABLE_PATH || '';
  if (configPath) return configPath;

  const candidates =
    process.platform === 'win32'
      ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
      : [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // skip
    }
  }
  return undefined;
}

const executablePath = detectSystemChrome();
const userDataDir = process.env.PUPPETEER_USER_DATA_DIR || undefined;

const launchOptions = {
  headless: false,
  defaultViewport: null, // use window size
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Prevent shared memory crashes on Linux (heavy pages)
    '--disable-accelerated-2d-canvas',
    '--no-zygote',
    '--start-maximized',
    '--window-size=1400,900',

    // Strip automation indicators
    '--disable-blink-features=AutomationControlled',

    // Clean profile — no extensions loaded
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-component-extensions-with-background-pages',

    // Disable infobars ("Chrome is being controlled by automated test software")
    '--disable-infobars',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
  ...(executablePath ? { executablePath } : {}),
  ...(userDataDir ? { userDataDir } : {}),
};

if (executablePath) console.log(`Using system Chrome: ${executablePath}`);
if (userDataDir) console.log(`Using persistent profile: ${userDataDir}`);

const browser = await puppeteer.launch(launchOptions);

const page = (await browser.pages())[0] || (await browser.newPage());

// Capture page console logs and errors to debug LinkedIn logouts/crashes
const logFile = 'linkedin-inspect.log';
page.on('console', (msg) => {
  const type = msg.type();
  const rawText = msg.text();

  const location = msg.location();
  if (
    rawText.includes('net::ERR_BLOCKED_BY_CLIENT.Inspector') ||
    (location && location.url && location.url.includes('chrome-extension://invalid'))
  ) {
    return;
  }

  if (type === 'error' || type === 'warning' || type === 'log') {
    let text = `[PAGE_${type.toUpperCase()}] ${rawText}`;

    // Attempt to extract stack traces from the arguments if it's an EvalError or generic Exception
    const args = msg.args();
    if (args && args.length > 0 && typeof args[0].remoteObject === 'function') {
      const remoteObj = args[0].remoteObject();
      if (remoteObj && remoteObj.description) {
        text += `\n    -> Details: ${remoteObj.description}`;
      }
    } else {
      // Fallback: log the location where the console message originated
      const location = msg.location();
      if (location && location.url) {
        text += `\n    -> Source: ${location.url}:${location.lineNumber}:${location.columnNumber}`;
      }
    }

    text += '\n';

    console.log(text.trim());
    fs.appendFileSync(logFile, text);
  }
});
page.on('pageerror', (err) => {
  const text = `[PAGE_EXCEPTION] ${err.toString()}\n`;
  console.error(text.trim());
  fs.appendFileSync(logFile, text);
});

// Load or create fingerprint profile if requested
const useProfile = process.env.FINGERPRINT_PROFILE === '1';
let profile = null;
if (useProfile) {
  const profileDir = './inspect-profile/';
  profile = loadOrCreateProfile(profileDir);
  console.log(`[FingerprintProfile] Using persistent profile from ${profileDir}`);
  console.log(`[FingerprintProfile] Seed: ${profile.seed.slice(0, 8)}...`);
  console.log(`[FingerprintProfile] UA: ${profile.userAgent}`);
  console.log(`[FingerprintProfile] GPU: ${profile.gpuProfile.renderer}`);
}

// Random user agent
const userAgent = profile ? profile.userAgent : (RandomHelpers.getRandomUserAgent() ?? '');
await page.setUserAgent(userAgent);

// Request interception: block chrome-extension:// requests
// await page.setRequestInterception(true);
// page.on('request', (req) => {
//   if (req.url().startsWith('chrome-extension://')) {
//     req.abort('blockedbyclient');
//   } else {
//     req.continue();
//   }
// });

// Fingerprint noise injection and headless evasion
const noiseEnabled = (process.env.PUPPETEER_FINGERPRINT_NOISE ?? 'true').toLowerCase() !== 'false';

// Always apply custom headless evasion since we disabled the stealth plugin
if (profile) {
  await page.evaluateOnNewDocument(getHeadlessEvasionScript({
    platform: profile.platform,
    language: profile.language,
    pluginCount: profile.pluginCount,
  }));
} else {
  await page.evaluateOnNewDocument(getHeadlessEvasionScript());
}

if (noiseEnabled) {
  if (profile) {
    await page.evaluateOnNewDocument(getCanvasNoiseScript(profile.canvasNoiseSeed));
    await page.evaluateOnNewDocument(getWebGLSpoofScript(profile.gpuProfile));
    await page.evaluateOnNewDocument(getAudioNoiseScript(profile.audioNoiseSeed));
    console.log('Fingerprint profile noise injected.');
  } else {
    await page.evaluateOnNewDocument(getCanvasNoiseScript(Math.floor(Math.random() * 1000000)));
    await page.evaluateOnNewDocument(getWebGLSpoofScript(GPU_PROFILES[Math.floor(Math.random() * GPU_PROFILES.length)]));
    await page.evaluateOnNewDocument(getAudioNoiseScript(Math.floor(Math.random() * 1000000)));
    console.log('Random session noise injected.');
  }
} else {
  console.log('Fingerprint noise disabled (PUPPETEER_FINGERPRINT_NOISE=false)');
}

const viewport = profile ? { width: profile.screenResolution.width, height: profile.screenResolution.height } : { width: 1400, height: 900 };
await page.setViewport(viewport);

console.log('Browser launched — navigating to linkedin.com');
await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded' });

// Keep process alive until the browser is closed
browser.on('disconnected', () => {
  console.log('Browser closed.');
  process.exit(0);
});

// Handle Ctrl-C gracefully
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await browser.close();
});
