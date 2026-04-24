import { describe, it, expect, vi, afterEach } from 'vitest';

// The global setup file mocks './shared/utils/logger.js' site-wide. Unmock it
// here so we exercise the real module under test.
vi.unmock('./logger.js');
vi.unmock('#utils/logger.js');

const winstonSpies = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  add: vi.fn(),
}));

vi.mock('winston', () => {
  const createLogger = vi.fn(() => ({
    log: winstonSpies.log,
    warn: winstonSpies.warn,
    add: winstonSpies.add,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }));
  const format = {
    combine: vi.fn(),
    timestamp: vi.fn(),
    errors: vi.fn(),
    json: vi.fn(),
    colorize: vi.fn(),
    printf: vi.fn(),
  };
  const transports = {
    File: vi.fn(),
    Console: vi.fn(),
  };
  return {
    default: { createLogger, format, transports },
    createLogger,
    format,
    transports,
  };
});

vi.mock('../config/index.js', () => ({
  config: { nodeEnv: 'production' },
}));

afterEach(async () => {
  const { logger } = await import('./logger.js');
  await logger.__flush();
  winstonSpies.log.mockReset();
  winstonSpies.warn.mockReset();
  winstonSpies.add.mockReset();
});

describe('client async logger', () => {
  it('returns synchronously when logging a burst', async () => {
    const { logger } = await import('./logger.js');
    const started = Date.now();
    for (let i = 0; i < 500; i++) {
      logger.info(`event ${i}`);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
  });

  it('flushes all entries to winston in order', async () => {
    const { logger } = await import('./logger.js');
    for (let i = 0; i < 10; i++) {
      logger.info(`msg-${i}`);
    }
    await logger.__flush();
    const infoMessages = winstonSpies.log.mock.calls
      .map((c) => c[1])
      .filter((m) => typeof m === 'string' && (m as string).startsWith('msg-'));
    expect(infoMessages).toEqual([
      'msg-0',
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
      'msg-5',
      'msg-6',
      'msg-7',
      'msg-8',
      'msg-9',
    ]);
  });

  it('drops the oldest entry and records the count on overflow', async () => {
    const { logger } = await import('./logger.js');
    const beforeDropped = logger.__droppedCount();
    // A synchronous burst of 1100 — the drain is async so the queue fills past
    // its cap before the first microtask runs.
    for (let i = 0; i < 1100; i++) {
      logger.warn(`burst-${i}`);
    }
    const afterDropped = logger.__droppedCount();
    expect(afterDropped - beforeDropped).toBeGreaterThanOrEqual(10);
    await logger.__flush();
    // After the flush, the overflow warn carries the drop count.
    const overflowCall = winstonSpies.warn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('overflow')
    );
    expect(overflowCall).toBeTruthy();
  });

  it('logs flush failures to console.error without recursing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    winstonSpies.log.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { logger } = await import('./logger.js');
    logger.error('boom');
    await logger.__flush();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
