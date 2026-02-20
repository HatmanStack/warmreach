#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Launch a non-headless Puppeteer browser for manual LinkedIn fingerprint inspection.
 *
 * Usage:  node client/linkedin-inspect.mjs
 *
 * The browser opens with the full stealth mitigation stack active (stealth plugin +
 * canvas/WebGL/audio fingerprint noise), a clean profile (no extensions), disabled
 * automation signals, and a realistic viewport so you can inspect what LinkedIn sees.
 * Close the browser window or press Ctrl-C to exit.
 *
 * Set PUPPETEER_STEALTH=false to disable stealth plugin for comparison testing.
 * Set PUPPETEER_FINGERPRINT_NOISE=false to disable canvas/WebGL/audio noise.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
} from './src/domains/automation/utils/stealthScripts.ts';

const stealthEnabled = (process.env.PUPPETEER_STEALTH ?? 'true').toLowerCase() !== 'false';
if (stealthEnabled) {
  puppeteer.use(StealthPlugin());
  console.log('Stealth plugin enabled');
} else {
  console.log('Stealth plugin disabled (PUPPETEER_STEALTH=false)');
}

const browser = await puppeteer.launch({
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
  ignoreDefaultArgs: ['--enable-automation'], // removes "controlled by automation" flag
});

const page = (await browser.pages())[0] || (await browser.newPage());

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
