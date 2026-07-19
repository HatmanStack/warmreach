import path from 'path';
import { createRequire } from 'module';
import winston from 'winston';
import { config } from '../config/index.js';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf((info: winston.Logform.TransformableInfo) => {
    const { timestamp, level, message, stack } = info;
    // Render meta (e.g. {error, type} from logger.error('Command X failed',
    // {...})) inline so the terminal shows the same payload the JSON file
    // does. Without this, the line ends at the message and the actual
    // diagnostic disappears off the console.
    const reserved = new Set(['timestamp', 'level', 'message', 'stack', 'service']);
    const meta: Record<string, unknown> = {};
    for (const key of Object.keys(info)) {
      if (!reserved.has(key) && typeof key === 'string' && !key.startsWith('Symbol(')) {
        meta[key] = (info as Record<string, unknown>)[key];
      }
    }
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const body = (stack as string | undefined) || (message as string);
    return `${timestamp as string} [${level}]: ${body}${metaStr}`;
  })
);

// Resolve a writable log directory + detect packaged Electron. In Electron
// we want userData (survives AppImage remounts, lives under ~/.config/<app>).
// Outside Electron — tests, dev:client without tray, CI — fall back to
// cwd/logs.
//
// NODE_ENV is not set inside a packaged AppImage, so config.nodeEnv falls
// back to 'development' and the log level would stay at debug. `app.isPackaged`
// is the canonical signal for "running from a packed binary" — use that
// instead.
function resolveElectronContext(): { logDir: string; packaged: boolean } {
  const override = process.env.WARMREACH_LOG_DIR;
  try {
    const require_ = createRequire(import.meta.url);
    const electron = require_('electron') as {
      app?: { getPath?: (k: string) => string; isPackaged?: boolean };
    };
    const userData = electron?.app?.getPath?.('userData');
    const packaged = electron?.app?.isPackaged === true;
    return {
      logDir:
        override || (userData ? path.join(userData, 'logs') : path.join(process.cwd(), 'logs')),
      packaged,
    };
  } catch {
    return { logDir: override || path.join(process.cwd(), 'logs'), packaged: false };
  }
}

const { logDir: LOG_DIR, packaged: IS_PACKAGED } = resolveElectronContext();
const isDev = !IS_PACKAGED && config.nodeEnv !== 'production';

// An explicit LOG_LEVEL env var overrides the dev/prod default, so the packaged
// AppImage can be turned up to info/debug on demand (e.g. LOG_LEVEL=debug in
// .env) to trace a run, then turned back down — no rebuild required. Invalid
// values fall through to the dev/prod default below.
const VALID_LEVELS = new Set(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']);
const envLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const LOG_LEVEL = envLevel && VALID_LEVELS.has(envLevel) ? envLevel : isDev ? 'debug' : 'warn';

const winstonLogger: winston.Logger = winston.createLogger({
  // Dev keeps debug-level chatter. Prod raises the floor so the terminal
  // tail (and error.log file) stay readable — info-level WS reconnect
  // spam was burying real failures. LOG_LEVEL overrides both.
  level: LOG_LEVEL,
  format: logFormat,
  defaultMeta: { service: 'warmreach-agent' },
  transports: [
    // Winston's File transport is already async (writeStream with
    // backpressure), so no sync fs calls on the hot error path.
    // Always-on in dev and prod — these are the only persistent record
    // of failures once the AppImage terminal scrolls past.
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
    // Console transport stays on in prod so the launching terminal still
    // shows warn/error lines — but at the elevated level set above.
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

// Bounded in-memory queue: under burst load we buffer log events and drain
// them asynchronously. When the queue fills, the oldest entry is dropped and
// a ``loggerDropped`` counter is emitted on the next successful flush so ops
// can alarm on sustained overflow.
const QUEUE_CAP = 1000;

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: unknown;
  meta: unknown[];
}

const queue: LogEntry[] = [];
let droppedCount = 0;
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Yield once so synchronous callers do not block on the drain.
    await Promise.resolve();
    while (queue.length > 0) {
      const entry = queue.shift()!;
      try {
        winstonLogger.log(entry.level, entry.message as string, ...(entry.meta as unknown[]));
      } catch (err) {
        // Never recurse into the logger itself.
        // eslint-disable-next-line no-console
        console.error('[logger] flush failed:', err);
      }
    }
    if (droppedCount > 0) {
      const n = droppedCount;
      droppedCount = 0;
      winstonLogger.warn('logger queue overflow dropped entries', { loggerDropped: n });
    }
  } finally {
    draining = false;
  }
}

function enqueue(level: LogEntry['level'], message: unknown, meta: unknown[]): void {
  if (queue.length >= QUEUE_CAP) {
    // Drop the oldest entry to make room for the newest.
    queue.shift();
    droppedCount += 1;
  }
  queue.push({ level, message, meta });
  // Fire-and-forget drain; promise rejections are swallowed in the loop.
  void drain();
}

export const logger = {
  debug: (message: unknown, ...meta: unknown[]) => enqueue('debug', message, meta),
  info: (message: unknown, ...meta: unknown[]) => enqueue('info', message, meta),
  warn: (message: unknown, ...meta: unknown[]) => enqueue('warn', message, meta),
  error: (message: unknown, ...meta: unknown[]) => enqueue('error', message, meta),
  // Test hooks — intentionally not part of the documented public API.
  __queueLength: () => queue.length,
  __droppedCount: () => droppedCount,
  __flush: () => drain(),
};

export type Logger = typeof logger;
