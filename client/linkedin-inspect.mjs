#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Launch a non-headless Puppeteer browser for manual LinkedIn fingerprint inspection.
 *
 * Usage:
 *   cd client && node --import tsx linkedin-inspect.mjs            # normal (Puppeteer launch)
 *   cd client && node --import tsx linkedin-inspect.mjs --connect  # connect to existing Chrome
 *
 * --connect mode:
 *   Launches Chrome as a normal process with --remote-debugging-port, then attaches
 *   Puppeteer via connect(). This avoids Puppeteer's launch-time automation flags
 *   and may reduce CDP fingerprint surface that triggers LinkedIn EvalError logouts.
 *
 * Close the browser window or press Ctrl-C to exit.
 *
 * Environment variables:
 *   PUPPETEER_FINGERPRINT_NOISE=false   Disable canvas/WebGL/audio noise
 *   FINGERPRINT_PROFILE=1               Use persistent fingerprint profile
 *   PUPPETEER_USER_DATA_DIR=<path>      Persistent Chrome profile directory
 *   CHROME_EXECUTABLE_PATH=<path>       Custom Chrome binary path
 *   CONNECT_PORT=<port>                 Remote debugging port (default: 9222)
 */

import fs from 'fs';
import { spawn } from 'child_process';
import puppeteer from 'puppeteer';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
  getHeadlessEvasionScript,
} from './src/domains/automation/utils/stealthScripts.ts';
import { loadOrCreateProfile, GPU_PROFILES } from './src/domains/automation/utils/fingerprintProfile.ts';
import { RandomHelpers } from './src/shared/utils/randomHelpers.js';

const connectMode = process.argv.includes('--connect');

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

if (executablePath) console.log(`Using system Chrome: ${executablePath}`);
if (userDataDir) console.log(`Using persistent profile: ${userDataDir}`);

// --- Browser acquisition ---
let browser;
let chromeProcess;

if (connectMode) {
  const port = process.env.CONNECT_PORT || '9222';
  const chromePath = executablePath;
  if (!chromePath) {
    console.error('--connect requires a system Chrome. Set CHROME_EXECUTABLE_PATH or install Chrome/Chromium.');
    process.exit(1);
  }

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--start-maximized',
    '--window-size=1400,900',
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
  ];

  console.log(`Launching Chrome with --remote-debugging-port=${port}...`);
  chromeProcess = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Wait for DevTools to be ready
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome did not start within 10s')), 10000);
    let stderr = '';

    chromeProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // Chrome prints "DevTools listening on ws://..." to stderr
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    chromeProcess.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited with code ${code}. stderr:\n${stderr}`));
    });
  });

  console.log(`Connecting to ${wsEndpoint}`);
  browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  console.log('Connected to Chrome (no Puppeteer launch flags)');
} else {
  console.log('Using standard Puppeteer launch');
  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-zygote',
      '--start-maximized',
      '--window-size=1400,900',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-component-extensions-with-background-pages',
      '--disable-infobars',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    ...(executablePath ? { executablePath } : {}),
    ...(userDataDir ? { userDataDir } : {}),
  };

  browser = await puppeteer.launch(launchOptions);
}

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

const userAgent = profile ? profile.userAgent : (RandomHelpers.getRandomUserAgent() ?? '');
const noiseEnabled = (process.env.PUPPETEER_FINGERPRINT_NOISE ?? 'true').toLowerCase() !== 'false';
const viewport = profile ? { width: profile.screenResolution.width, height: profile.screenResolution.height } : { width: 1400, height: 900 };

// Stable noise seeds for the session (reused across all tabs)
const canvasSeed = profile?.canvasNoiseSeed ?? Math.floor(Math.random() * 1000000);
const audioSeed = profile?.audioNoiseSeed ?? Math.floor(Math.random() * 1000000);
const gpuProfile = profile?.gpuProfile ?? GPU_PROFILES[Math.floor(Math.random() * GPU_PROFILES.length)];

// Inject evasion scripts on a page — called for initial page and every new tab
async function injectEvasionScripts(targetPage) {
  await targetPage.setUserAgent(userAgent);
  await targetPage.setViewport(viewport);

  if (profile) {
    await targetPage.evaluateOnNewDocument(getHeadlessEvasionScript({
      platform: profile.platform,
      language: profile.language,
      pluginCount: profile.pluginCount,
    }));
  } else {
    await targetPage.evaluateOnNewDocument(getHeadlessEvasionScript());
  }

  if (noiseEnabled) {
    await targetPage.evaluateOnNewDocument(getCanvasNoiseScript(canvasSeed));
    await targetPage.evaluateOnNewDocument(getWebGLSpoofScript(gpuProfile));
    await targetPage.evaluateOnNewDocument(getAudioNoiseScript(audioSeed));
  }
}

// Inject on the initial page
await injectEvasionScripts(page);

// Auto-inject on every new tab (e.g. "open link in new tab")
browser.on('targetcreated', async (target) => {
  if (target.type() !== 'page') return;
  try {
    const newPage = await target.page();
    if (!newPage) return;
    console.log('[new tab] Injecting evasion scripts');
    await injectEvasionScripts(newPage);
  } catch {
    // Target may close before we can attach
  }
});

if (noiseEnabled) {
  console.log(profile ? 'Fingerprint profile noise injected.' : 'Random session noise injected.');
} else {
  console.log('Fingerprint noise disabled (PUPPETEER_FINGERPRINT_NOISE=false)');
}

console.log(`Browser ready (${connectMode ? 'connect' : 'launch'} mode) — navigating to linkedin.com`);
await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded' });

// Keep process alive until the browser is closed
browser.on('disconnected', () => {
  console.log('Browser closed.');
  if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
  process.exit(0);
});

// Handle Ctrl-C gracefully
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  try { await browser.close(); } catch { /* already closed */ }
  if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
});
