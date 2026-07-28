import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
// 1) Service-local .env (client/.env)
dotenv.config({ path: path.join(__dirname, '../.env') });
// 2) Fallback/combined root .env (project/.env) if present
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Helper to parse boolean-like env values
/**
 * @param {string | undefined | null} value
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
};

/**
 * Read an integer environment variable.
 *
 * Replaces the hand-written env reads that were the whole of this file's
 * `checkJs` fallout: `process.env.X` is
 * `string | undefined` and `parseInt` takes `string`. Behaviour is unchanged --
 * an unset, empty, unparseable or zero value yields the fallback, exactly as
 * `|| fallback` did -- with one deliberate hardening: an explicit radix, so a
 * value like "0x10" reads as 0 rather than 16.
 *
 * Every variable this file reads is an optional tuning knob with a working
 * default, so this helper does not throw on a missing value. A loud-failure
 * variant was written and then removed: nothing in this file needs one, and an
 * exported helper with no call sites is the same debt Phase 1 deleted when it
 * removed the unadopted `api_error` (bb19b592).
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export const envInt = (name, fallback) => parseInt(process.env[name] ?? '', 10) || fallback;

/**
 * Read a floating-point environment variable. See {@link envInt}.
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export const envFloat = (name, fallback) => parseFloat(process.env[name] ?? '') || fallback;

// Hard-coded safety ceilings — cannot be exceeded via env vars.
// These protect LinkedIn's ecosystem and the project's reputation.
export const RATE_LIMIT_CEILINGS = {
  dailyInteractionLimit: 500,
  hourlyInteractionLimit: 100,
  rateLimitMax: 30,
  actionsPerMinute: 15,
  actionsPerHour: 200,
};

export const config = {
  // Server
  port: envInt('PORT', 3001),
  nodeEnv: process.env.NODE_ENV || 'development',

  // CORS
  frontendUrls: process.env.FRONTEND_URLS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5173',
  ],

  // LinkedIn Search
  linkedin: {
    // Testing mode: set to 'true' to use mock LinkedIn server at localhost:3333
    testingMode: parseBoolean(process.env.LINKEDIN_TESTING_MODE, false),
    // Base URL for LinkedIn (auto-set to localhost:3333 when testingMode is true)
    baseUrl: parseBoolean(process.env.LINKEDIN_TESTING_MODE, false)
      ? process.env.LINKEDIN_BASE_URL || 'http://localhost:3333'
      : process.env.LINKEDIN_BASE_URL || 'https://www.linkedin.com',
    recencyHours: envInt('RECENCY_HOURS', 6),
    recencyDays: envInt('RECENCY_DAYS', 5),
    recencyWeeks: envInt('RECENCY_WEEKS', 3),
    historyToCheck: envInt('HISTORY_TO_CHECK', 4),
    threshold: envInt('THRESHOLD', 8),
    pageNumberStart: envInt('PAGE_NUMBER_START', 1),
    pageNumberEnd: envInt('PAGE_NUMBER_END', 100),
    // Dev/testing cap on how many connections per list (ally/incoming/outgoing)
    // profile-init ingests. 0 = no cap (ingest the entire list). Set e.g. 10 to
    // start small while iterating instead of pulling the full network.
    maxConnectionsPerType: envInt('PROFILE_INIT_MAX_CONNECTIONS', 0),
    // Dev toggle: when true, profile-init re-scrapes connections even if an edge
    // already exists (normally an existing edge short-circuits the scrape). Lets
    // us re-run scraping against the same connections while iterating on
    // selectors without manually clearing edges. Leave false in production.
    forceRescrape: parseBoolean(process.env.PROFILE_INIT_FORCE_RESCRAPE, false),
    // Dev toggle: dump each scraped profile's raw HTML to
    // <userData>/logs/profile-dumps for offline selector analysis. Leave false
    // in production.
    scrapeDumpHtml: parseBoolean(process.env.PROFILE_SCRAPE_DUMP_HTML, false),
    // Dev toggle: dump every search results page's raw HTML to
    // <userData>/logs/search-dumps. Note: empty result pages are dumped
    // automatically regardless of this flag, so an empty page is never
    // undiagnosed. Leave false in production.
    searchDumpHtml: parseBoolean(process.env.SEARCH_DUMP_HTML, false),
  },

  // Puppeteer
  puppeteer: {
    // Accept a variety of truthy/falsey strings; default to true if not specified
    headless: parseBoolean(process.env.HEADLESS, true),
    slowMo: envInt('SLOW_MO', 50),
    viewport: {
      width: envInt('VIEWPORT_WIDTH', 1200),
      height: envInt('VIEWPORT_HEIGHT', 1200),
    },
    // Anti-fingerprint config
    userDataDir: process.env.PUPPETEER_USER_DATA_DIR || '',
    executablePath: process.env.CHROME_EXECUTABLE_PATH || '',
    enableStealth: parseBoolean(process.env.PUPPETEER_STEALTH, true),
    enableRequestInterception: parseBoolean(process.env.PUPPETEER_REQUEST_INTERCEPTION, true),
    enableFingerprintNoise: parseBoolean(process.env.PUPPETEER_FINGERPRINT_NOISE, true),
    enableMouseSimulation: parseBoolean(process.env.PUPPETEER_MOUSE_SIMULATION, true),
    // Escape hatch for containers/CI images that cannot grant unprivileged user
    // namespaces. Defaults to false: the sandbox is what contains a renderer
    // compromise, and this browser renders attacker-authored feed content.
    disableSandbox: parseBoolean(process.env.PUPPETEER_DISABLE_SANDBOX, false),
  },

  // Timeouts
  timeouts: {
    default: envInt('DEFAULT_TIMEOUT', 30000),
    navigation: envInt('NAVIGATION_TIMEOUT', 50000),
    login: envInt('LOGIN_SECURITY_TIMEOUT', 0),
  },

  // LinkedIn Interactions
  linkedinInteractions: {
    // Session Management (Requirement 6.5)
    sessionTimeout: envInt('LINKEDIN_SESSION_TIMEOUT', 3600000), // 1 hour
    sessionHealthCheckInterval: envInt('SESSION_HEALTH_CHECK_INTERVAL', 300000), // 5 minutes
    maxSessionErrors: envInt('MAX_SESSION_ERRORS', 5),
    sessionRecoveryTimeout: envInt('SESSION_RECOVERY_TIMEOUT', 60000), // 1 minute

    // Concurrency Control (Requirement 4.4)
    maxConcurrentInteractions: envInt('MAX_CONCURRENT_INTERACTIONS', 3),
    maxConcurrentSessions: envInt('MAX_CONCURRENT_SESSIONS', 1),
    interactionQueueSize: envInt('INTERACTION_QUEUE_SIZE', 50),

    // Rate Limiting (Requirement 9.4)
    rateLimitWindow: envInt('RATE_LIMIT_WINDOW', 60000), // 1 minute
    rateLimitMax: Math.min(envInt('RATE_LIMIT_MAX', 10), RATE_LIMIT_CEILINGS.rateLimitMax),
    dailyInteractionLimit: Math.min(
      envInt('DAILY_INTERACTION_LIMIT', 500),
      RATE_LIMIT_CEILINGS.dailyInteractionLimit
    ),
    hourlyInteractionLimit: Math.min(
      envInt('HOURLY_INTERACTION_LIMIT', 100),
      RATE_LIMIT_CEILINGS.hourlyInteractionLimit
    ),

    // Retry Configuration (Requirement 4.4)
    retryAttempts: envInt('INTERACTION_RETRY_ATTEMPTS', 3),
    retryBaseDelay: envInt('INTERACTION_RETRY_BASE_DELAY', 1000), // 1 second
    retryMaxDelay: envInt('INTERACTION_RETRY_MAX_DELAY', 300000), // 5 minutes
    retryJitterFactor: envFloat('RETRY_JITTER_FACTOR', 0.1),

    // Human Behavior Simulation (Requirement 9.4)
    humanDelayMin: envInt('HUMAN_DELAY_MIN', 1000),
    humanDelayMax: envInt('HUMAN_DELAY_MAX', 3000),
    actionsPerMinute: Math.min(
      envInt('ACTIONS_PER_MINUTE', 8),
      RATE_LIMIT_CEILINGS.actionsPerMinute
    ),
    actionsPerHour: Math.min(envInt('ACTIONS_PER_HOUR', 100), RATE_LIMIT_CEILINGS.actionsPerHour),

    // Typing Simulation
    typingSpeedMin: envInt('TYPING_SPEED_MIN', 80), // WPM equivalent in ms
    typingSpeedMax: envInt('TYPING_SPEED_MAX', 150),
    typingPauseChance: envFloat('TYPING_PAUSE_CHANCE', 0.1), // 10% chance
    typingPauseMin: envInt('TYPING_PAUSE_MIN', 500),
    typingPauseMax: envInt('TYPING_PAUSE_MAX', 2000),

    // Mouse and Scroll Simulation
    mouseMovementSteps: envInt('MOUSE_MOVEMENT_STEPS', 5),
    mouseMovementDelay: envInt('MOUSE_MOVEMENT_DELAY', 100),
    scrollStepSize: envInt('SCROLL_STEP_SIZE', 120),
    scrollDelay: envInt('SCROLL_DELAY', 200),

    // Suspicious Activity Detection
    suspiciousActivityThreshold: envInt('SUSPICIOUS_ACTIVITY_THRESHOLD', 3),
    suspiciousActivityWindow: envInt('SUSPICIOUS_ACTIVITY_WINDOW', 300000), // 5 minutes
    cooldownMinDuration: envInt('COOLDOWN_MIN_DURATION', 30000), // 30 seconds
    cooldownMaxDuration: envInt('COOLDOWN_MAX_DURATION', 300000), // 5 minutes

    // Operation Timeouts
    navigationTimeout: envInt('LINKEDIN_NAVIGATION_TIMEOUT', 30000),
    elementWaitTimeout: envInt('ELEMENT_WAIT_TIMEOUT', 10000),
    messageComposeTimeout: envInt('MESSAGE_COMPOSE_TIMEOUT', 15000),
    postCreationTimeout: envInt('POST_CREATION_TIMEOUT', 20000),
    connectionRequestTimeout: envInt('CONNECTION_REQUEST_TIMEOUT', 15000),

    // Content Limits
    maxMessageLength: envInt('MAX_MESSAGE_LENGTH', 8000),
    maxPostLength: envInt('MAX_POST_LENGTH', 3000),
    maxConnectionMessageLength: envInt('MAX_CONNECTION_MESSAGE_LENGTH', 300),

    // Browser Configuration
    browserLaunchTimeout: envInt('BROWSER_LAUNCH_TIMEOUT', 30000),
    pageLoadTimeout: envInt('PAGE_LOAD_TIMEOUT', 30000),
    browserIdleTimeout: envInt('BROWSER_IDLE_TIMEOUT', 1800000), // 30 minutes

    // Error Handling
    maxConsecutiveErrors: envInt('MAX_CONSECUTIVE_ERRORS', 5),
    errorCooldownDuration: envInt('ERROR_COOLDOWN_DURATION', 60000), // 1 minute

    // Monitoring and Logging
    performanceLoggingEnabled: process.env.PERFORMANCE_LOGGING_ENABLED === 'true',
    auditLoggingEnabled: process.env.AUDIT_LOGGING_ENABLED !== 'false', // Default true
    metricsCollectionInterval: envInt('METRICS_COLLECTION_INTERVAL', 60000), // 1 minute

    // Feature Flags
    enableMessageSending: process.env.ENABLE_MESSAGE_SENDING !== 'false', // Default true
    enableConnectionRequests: process.env.ENABLE_CONNECTION_REQUESTS !== 'false', // Default true
    enablePostCreation: process.env.ENABLE_POST_CREATION !== 'false', // Default true

    // Development/Debug Settings
    debugMode: process.env.LINKEDIN_DEBUG_MODE === 'true',
    screenshotOnError: process.env.SCREENSHOT_ON_ERROR === 'true',
    savePageSourceOnError: process.env.SAVE_PAGE_SOURCE_ON_ERROR === 'true',
    verboseLogging: process.env.VERBOSE_LOGGING === 'true',
  },

  // File Paths
  paths: {
    linksFile: process.env.LINKS_FILE || './data/possible-links.json',
    goodConnectionsFile: process.env.GOOD_CONNECTIONS_FILE || './data/good-connections-links.json',
  },

  // Control Plane
  controlPlane: {
    url: process.env.CONTROL_PLANE_URL || '',
    deploymentId: process.env.CONTROL_PLANE_DEPLOYMENT_ID || '',
    apiKey: process.env.CONTROL_PLANE_API_KEY || '',
  },
};

export default config;
