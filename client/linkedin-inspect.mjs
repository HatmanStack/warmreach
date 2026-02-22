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
} from './src/domains/automation/utils/stealthScripts.ts';
import RandomHelpers from './src/shared/utils/randomHelpers.js';

const stealthEnabled = (process.env.PUPPETEER_STEALTH ?? 'true').toLowerCase() !== 'false';
if (stealthEnabled) {
  puppeteer.use(StealthPlugin());
  console.log('Stealth plugin enabled');
} else {
  console.log('Stealth plugin disabled (PUPPETEER_STEALTH=false)');
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

// Random user agent
const userAgent = RandomHelpers.getRandomUserAgent() ?? '';
await page.setUserAgent(userAgent);

// Request interception: block chrome-extension:// requests
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().startsWith('chrome-extension://')) {
    req.abort('blockedbyclient');
  } else {
    req.continue();
  }
});

// Fingerprint noise injection
const noiseEnabled = (process.env.PUPPETEER_FINGERPRINT_NOISE ?? 'true').toLowerCase() !== 'false';
if (noiseEnabled) {
  await page.evaluateOnNewDocument(getCanvasNoiseScript());
  await page.evaluateOnNewDocument(getWebGLSpoofScript());
  await page.evaluateOnNewDocument(getAudioNoiseScript());
  console.log('Fingerprint noise injection enabled');
} else {
  console.log('Fingerprint noise disabled (PUPPETEER_FINGERPRINT_NOISE=false)');
}

await page.setViewport({ width: 1400, height: 900 });

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
