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
  winston.format.printf(
    ({ timestamp, level, message, stack }: winston.Logform.TransformableInfo) => {
      return `${timestamp as string} [${level}]: ${(stack as string | undefined) || message}`;
    }
  )
);

const winstonLogger: winston.Logger = winston.createLogger({
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
  format: logFormat,
  defaultMeta: { service: 'warmreach-backend' },
  transports: [
    // Winston's File transport is already async (internally uses writeStream
    // with backpressure), so there are no synchronous fs calls on the hot
    // error path. Keeping the 5MB/5-file rotation identical.
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

if (config.nodeEnv === 'development') {
  winstonLogger.add(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

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
