// Puppeteer browser configuration
export const puppeteerConfig = {
  HEADLESS: process.env.PUPPETEER_HEADLESS !== 'false', // Default to true
  SLOW_MO: process.env.PUPPETEER_SLOW_MO ? parseInt(process.env.PUPPETEER_SLOW_MO) : 0,
  DEFAULT_TIMEOUT: 30000, // 30 seconds
  DEFAULT_NAVIGATION_TIMEOUT: 30000, // 30 seconds

  // Browser args
  BROWSER_ARGS: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
  ],

  // Viewport
  VIEWPORT: {
    width: 1920,
    height: 1080,
  },
};
