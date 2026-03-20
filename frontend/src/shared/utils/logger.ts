/**
 * Centralized logging service for the application
 *
 * Features:
 * - Environment-aware logging (dev vs production)
 * - Structured logging with context
 * - Automatic sensitive data masking
 * - Log levels: debug, info, warn, error
 * - Production-safe (no console clutter in prod)
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
}

/**
 * Rate limiter for error telemetry — max 10 sends per 60 seconds, with deduplication.
 */
const TELEMETRY_RATE_LIMIT = 10;
const TELEMETRY_WINDOW_MS = 60_000;
const _telemetrySendTimestamps: number[] = [];
const _recentErrorHashes = new Map<string, number>(); // hash -> timestamp

function _hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash.toString(36);
}

function _shouldSendTelemetry(message: string): boolean {
  const now = Date.now();

  // Deduplicate: skip if same error was reported in the last window
  const msgHash = _hashString(message);
  const lastSent = _recentErrorHashes.get(msgHash);
  if (lastSent && now - lastSent < TELEMETRY_WINDOW_MS) {
    return false;
  }

  // Rate limit: sliding window counter
  while (
    _telemetrySendTimestamps.length > 0 &&
    now - _telemetrySendTimestamps[0] > TELEMETRY_WINDOW_MS
  ) {
    _telemetrySendTimestamps.shift();
  }
  if (_telemetrySendTimestamps.length >= TELEMETRY_RATE_LIMIT) {
    return false;
  }

  // Allow the send
  _telemetrySendTimestamps.push(now);
  _recentErrorHashes.set(msgHash, now);

  // Clean up old hashes periodically
  if (_recentErrorHashes.size > 100) {
    for (const [key, ts] of _recentErrorHashes) {
      if (now - ts > TELEMETRY_WINDOW_MS) {
        _recentErrorHashes.delete(key);
      }
    }
  }

  return true;
}

/**
 * Sensitive field patterns to mask in logs
 */
const SENSITIVE_PATTERNS = [
  'password',
  'token',
  'secret',
  'apiKey',
  'accessToken',
  'refreshToken',
  'sessionId',
  'ssn',
  'creditCard',
  'cvv',
];

/**
 * Check if we're in development mode
 */
const isDevelopment = (): boolean => {
  return import.meta.env.DEV || import.meta.env.MODE === 'development';
};

/**
 * Mask sensitive data in objects
 */
const maskSensitiveData = (data: unknown): unknown => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveData(item));
  }

  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_PATTERNS.some((pattern) =>
      lowerKey.includes(pattern.toLowerCase())
    );

    if (isSensitive) {
      masked[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskSensitiveData(value);
    } else {
      masked[key] = value;
    }
  }

  return masked;
};

/**
 * Format log entry for output
 */
const formatLogEntry = (entry: LogEntry): string => {
  const { timestamp, level, message, context } = entry;
  const levelStr = level.toUpperCase().padEnd(5);

  let output = `[${timestamp}] ${levelStr} ${message}`;

  if (context && Object.keys(context).length > 0) {
    const maskedContext = maskSensitiveData(context);
    output += ` ${JSON.stringify(maskedContext)}`;
  }

  return output;
};

/**
 * Log a message at the specified level
 */
const log = (level: LogLevel, message: string, context?: LogContext): void => {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context: context ? (maskSensitiveData(context) as LogContext) : undefined,
  };

  // In production, only log warnings and errors
  if (!isDevelopment() && (level === 'debug' || level === 'info')) {
    return;
  }

  // Format and output the log
  const formatted = formatLogEntry(entry);

  switch (level) {
    case 'debug':
      if (isDevelopment()) {
        console.debug(formatted);
      }
      break;
    case 'info':
      if (isDevelopment()) {
        console.info(formatted);
      }
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'error':
      console.error(formatted);
      break;
  }

  // In production, send errors to a monitoring service (rate-limited)
  if (!isDevelopment() && level === 'error' && _shouldSendTelemetry(message)) {
    try {
      const telemetryEndpoint = import.meta.env.VITE_TELEMETRY_ENDPOINT || '/api/telemetry/error';
      fetch(telemetryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, context: entry.context, timestamp: entry.timestamp }),
        keepalive: true,
      }).catch(() => {
        // Silently ignore telemetry failures to prevent infinite error loops
      });
    } catch {
      // Ignore synchronous errors in telemetry
    }
  }
};

/**
 * Logger API
 */
const logger = {
  /**
   * Log debug information (dev only)
   */
  debug: (message: string, context?: LogContext): void => {
    log('debug', message, context);
  },

  /**
   * Log informational messages (dev only)
   */
  info: (message: string, context?: LogContext): void => {
    log('info', message, context);
  },

  /**
   * Log warning messages (dev and prod)
   */
  warn: (message: string, context?: LogContext): void => {
    log('warn', message, context);
  },

  /**
   * Log error messages (dev and prod)
   */
  error: (message: string, context?: LogContext): void => {
    log('error', message, context);
  },

  /**
   * Log with custom level
   */
  log: (level: LogLevel, message: string, context?: LogContext): void => {
    log(level, message, context);
  },
};

/**
 * Helper to create a scoped logger for a specific module
 */
export const createLogger = (module: string) => ({
  debug: (message: string, context?: LogContext) => logger.debug(`[${module}] ${message}`, context),
  info: (message: string, context?: LogContext) => logger.info(`[${module}] ${message}`, context),
  warn: (message: string, context?: LogContext) => logger.warn(`[${module}] ${message}`, context),
  error: (message: string, context?: LogContext) => logger.error(`[${module}] ${message}`, context),
});
