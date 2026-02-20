import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ragstackConfig } from '../src/shared/config/ragstack.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
// 1) Service-local .env (client/.env)
dotenv.config({ path: path.join(__dirname, '../.env') });
// 2) Fallback/combined root .env (project/.env) if present
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Helper to parse boolean-like env values
const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
};

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
  port: parseInt(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  // CORS
  frontendUrls: process.env.FRONTEND_URLS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5173'
  ],

  // LinkedIn Search
  linkedin: {
    // Testing mode: set to 'true' to use mock LinkedIn server at localhost:3333
    testingMode: parseBoolean(process.env.LINKEDIN_TESTING_MODE, false),
    // Base URL for LinkedIn (auto-set to localhost:3333 when testingMode is true)
    baseUrl: parseBoolean(process.env.LINKEDIN_TESTING_MODE, false)
      ? (process.env.LINKEDIN_BASE_URL || 'http://localhost:3333')
      : (process.env.LINKEDIN_BASE_URL || 'https://www.linkedin.com'),
    recencyHours: parseInt(process.env.RECENCY_HOURS) || 6,
    recencyDays: parseInt(process.env.RECENCY_DAYS) || 5,
    recencyWeeks: parseInt(process.env.RECENCY_WEEKS) || 3,
    historyToCheck: parseInt(process.env.HISTORY_TO_CHECK) || 4,
    threshold: parseInt(process.env.THRESHOLD) || 8,
    pageNumberStart: parseInt(process.env.PAGE_NUMBER_START) || 1,
    pageNumberEnd: parseInt(process.env.PAGE_NUMBER_END) || 100,
  },

  // Puppeteer
  puppeteer: {
    // Accept a variety of truthy/falsey strings; default to true if not specified
    headless: parseBoolean(process.env.HEADLESS, true),
    slowMo: parseInt(process.env.SLOW_MO) || 50,
    viewport: {
      width: parseInt(process.env.VIEWPORT_WIDTH) || 1200,
      height: parseInt(process.env.VIEWPORT_HEIGHT) || 1200,
    },
    // Anti-fingerprint config
    userDataDir: process.env.PUPPETEER_USER_DATA_DIR || '',
    executablePath: process.env.CHROME_EXECUTABLE_PATH || '',
    enableStealth: parseBoolean(process.env.PUPPETEER_STEALTH, true),
    enableRequestInterception: parseBoolean(process.env.PUPPETEER_REQUEST_INTERCEPTION, true),
    enableFingerprintNoise: parseBoolean(process.env.PUPPETEER_FINGERPRINT_NOISE, true),
    enableMouseSimulation: parseBoolean(process.env.PUPPETEER_MOUSE_SIMULATION, true),
  },

  // Timeouts
  timeouts: {
    default: parseInt(process.env.DEFAULT_TIMEOUT) || 30000,
    navigation: parseInt(process.env.NAVIGATION_TIMEOUT) || 50000,
    login: parseInt(process.env.LOGIN_SECURITY_TIMEOUT) || 0,
  },

  // LinkedIn Interactions
  linkedinInteractions: {
    // Session Management (Requirement 6.5)
    sessionTimeout: parseInt(process.env.LINKEDIN_SESSION_TIMEOUT) || 3600000, // 1 hour
    sessionHealthCheckInterval: parseInt(process.env.SESSION_HEALTH_CHECK_INTERVAL) || 300000, // 5 minutes
    maxSessionErrors: parseInt(process.env.MAX_SESSION_ERRORS) || 5,
    sessionRecoveryTimeout: parseInt(process.env.SESSION_RECOVERY_TIMEOUT) || 60000, // 1 minute

    // Concurrency Control (Requirement 4.4)
    maxConcurrentInteractions: parseInt(process.env.MAX_CONCURRENT_INTERACTIONS) || 3,
    maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS) || 1,
    interactionQueueSize: parseInt(process.env.INTERACTION_QUEUE_SIZE) || 50,

    // Rate Limiting (Requirement 9.4)
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000, // 1 minute
    rateLimitMax: Math.min(parseInt(process.env.RATE_LIMIT_MAX) || 10, RATE_LIMIT_CEILINGS.rateLimitMax),
    dailyInteractionLimit: Math.min(parseInt(process.env.DAILY_INTERACTION_LIMIT) || 500, RATE_LIMIT_CEILINGS.dailyInteractionLimit),
    hourlyInteractionLimit: Math.min(parseInt(process.env.HOURLY_INTERACTION_LIMIT) || 100, RATE_LIMIT_CEILINGS.hourlyInteractionLimit),

    // Retry Configuration (Requirement 4.4)
    retryAttempts: parseInt(process.env.INTERACTION_RETRY_ATTEMPTS) || 3,
    retryBaseDelay: parseInt(process.env.INTERACTION_RETRY_BASE_DELAY) || 1000, // 1 second
    retryMaxDelay: parseInt(process.env.INTERACTION_RETRY_MAX_DELAY) || 300000, // 5 minutes
    retryJitterFactor: parseFloat(process.env.RETRY_JITTER_FACTOR) || 0.1,

    // Human Behavior Simulation (Requirement 9.4)
    humanDelayMin: parseInt(process.env.HUMAN_DELAY_MIN) || 1000,
    humanDelayMax: parseInt(process.env.HUMAN_DELAY_MAX) || 3000,
    actionsPerMinute: Math.min(parseInt(process.env.ACTIONS_PER_MINUTE) || 8, RATE_LIMIT_CEILINGS.actionsPerMinute),
    actionsPerHour: Math.min(parseInt(process.env.ACTIONS_PER_HOUR) || 100, RATE_LIMIT_CEILINGS.actionsPerHour),

    // Typing Simulation
    typingSpeedMin: parseInt(process.env.TYPING_SPEED_MIN) || 80, // WPM equivalent in ms
    typingSpeedMax: parseInt(process.env.TYPING_SPEED_MAX) || 150,
    typingPauseChance: parseFloat(process.env.TYPING_PAUSE_CHANCE) || 0.1, // 10% chance
    typingPauseMin: parseInt(process.env.TYPING_PAUSE_MIN) || 500,
    typingPauseMax: parseInt(process.env.TYPING_PAUSE_MAX) || 2000,

    // Mouse and Scroll Simulation
    mouseMovementSteps: parseInt(process.env.MOUSE_MOVEMENT_STEPS) || 5,
    mouseMovementDelay: parseInt(process.env.MOUSE_MOVEMENT_DELAY) || 100,
    scrollStepSize: parseInt(process.env.SCROLL_STEP_SIZE) || 120,
    scrollDelay: parseInt(process.env.SCROLL_DELAY) || 200,

    // Suspicious Activity Detection
    suspiciousActivityThreshold: parseInt(process.env.SUSPICIOUS_ACTIVITY_THRESHOLD) || 3,
    suspiciousActivityWindow: parseInt(process.env.SUSPICIOUS_ACTIVITY_WINDOW) || 300000, // 5 minutes
    cooldownMinDuration: parseInt(process.env.COOLDOWN_MIN_DURATION) || 30000, // 30 seconds
    cooldownMaxDuration: parseInt(process.env.COOLDOWN_MAX_DURATION) || 300000, // 5 minutes

    // Operation Timeouts
    navigationTimeout: parseInt(process.env.LINKEDIN_NAVIGATION_TIMEOUT) || 30000,
    elementWaitTimeout: parseInt(process.env.ELEMENT_WAIT_TIMEOUT) || 10000,
    messageComposeTimeout: parseInt(process.env.MESSAGE_COMPOSE_TIMEOUT) || 15000,
    postCreationTimeout: parseInt(process.env.POST_CREATION_TIMEOUT) || 20000,
    connectionRequestTimeout: parseInt(process.env.CONNECTION_REQUEST_TIMEOUT) || 15000,

    // Content Limits
    maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH) || 8000,
    maxPostLength: parseInt(process.env.MAX_POST_LENGTH) || 3000,
    maxConnectionMessageLength: parseInt(process.env.MAX_CONNECTION_MESSAGE_LENGTH) || 300,

    // Browser Configuration
    browserLaunchTimeout: parseInt(process.env.BROWSER_LAUNCH_TIMEOUT) || 30000,
    pageLoadTimeout: parseInt(process.env.PAGE_LOAD_TIMEOUT) || 30000,
    browserIdleTimeout: parseInt(process.env.BROWSER_IDLE_TIMEOUT) || 1800000, // 30 minutes

    // Error Handling
    maxConsecutiveErrors: parseInt(process.env.MAX_CONSECUTIVE_ERRORS) || 5,
    errorCooldownDuration: parseInt(process.env.ERROR_COOLDOWN_DURATION) || 60000, // 1 minute

    // Monitoring and Logging
    performanceLoggingEnabled: process.env.PERFORMANCE_LOGGING_ENABLED === 'true',
    auditLoggingEnabled: process.env.AUDIT_LOGGING_ENABLED !== 'false', // Default true
    metricsCollectionInterval: parseInt(process.env.METRICS_COLLECTION_INTERVAL) || 60000, // 1 minute

    // Feature Flags
    enableMessageSending: process.env.ENABLE_MESSAGE_SENDING !== 'false', // Default true
    enableConnectionRequests: process.env.ENABLE_CONNECTION_REQUESTS !== 'false', // Default true
    enablePostCreation: process.env.ENABLE_POST_CREATION !== 'false', // Default true

    // Development/Debug Settings
    debugMode: process.env.LINKEDIN_DEBUG_MODE === 'true',
    screenshotOnError: process.env.SCREENSHOT_ON_ERROR === 'true',
    savePageSourceOnError: process.env.SAVE_PAGE_SOURCE_ON_ERROR === 'true',
    verboseLogging: process.env.VERBOSE_LOGGING === 'true'
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

  // RAGStack Configuration
  ragstack: ragstackConfig,
};

export default config;
