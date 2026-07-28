import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBeforeQuitHandler, BROWSER_CLEANUP_TIMEOUT_MS } from './appShutdown.js';

describe('buildBeforeQuitHandler (HIGH #6)', () => {
  let app: { quit: ReturnType<typeof vi.fn> };
  let wsClient: { close: ReturnType<typeof vi.fn> } | null;
  let cleanupBrowser: ReturnType<typeof vi.fn>;
  let event: { preventDefault: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    app = { quit: vi.fn() };
    wsClient = { close: vi.fn() };
    cleanupBrowser = vi.fn(async () => {});
    event = { preventDefault: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const build = (timeoutMs?: number) =>
    buildBeforeQuitHandler({
      app,
      getWsClient: () => wsClient,
      cleanupBrowser,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  it('closes the WebSocket, cleans up the browser, then quits', async () => {
    await build()(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(wsClient!.close).toHaveBeenCalledOnce();
    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('quits only after cleanup resolves, not before', async () => {
    let releaseCleanup: () => void = () => {};
    cleanupBrowser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        })
    );

    const pending = build()(event);
    await Promise.resolve();
    expect(app.quit).not.toHaveBeenCalled();

    releaseCleanup();
    await pending;
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('is idempotent — a second before-quit runs cleanup once and does not re-prevent the quit', async () => {
    const handler = build();

    await handler(event);
    const second = { preventDefault: vi.fn() };
    await handler(second);

    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    // The re-entrant before-quit raised by the handler's own app.quit() must
    // NOT be intercepted, or the app would never actually exit.
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('still quits when cleanup hangs past the timeout', async () => {
    vi.useFakeTimers();
    // Never resolves — a wedged Chromium close().
    cleanupBrowser = vi.fn(() => new Promise<void>(() => {}));

    const pending = build()(event);
    await vi.advanceTimersByTimeAsync(BROWSER_CLEANUP_TIMEOUT_MS + 1);
    await pending;

    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('does not quit before the timeout elapses while cleanup is hung', async () => {
    vi.useFakeTimers();
    cleanupBrowser = vi.fn(() => new Promise<void>(() => {}));

    const pending = build()(event);
    await vi.advanceTimersByTimeAsync(BROWSER_CLEANUP_TIMEOUT_MS - 1);
    expect(app.quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('quits when cleanup rejects', async () => {
    cleanupBrowser = vi.fn(async () => {
      throw new Error('browser.close() exploded');
    });

    await build()(event);

    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('quits when the WebSocket client is absent', async () => {
    wsClient = null;

    await build()(event);

    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('quits when closing the WebSocket throws', async () => {
    wsClient = {
      close: vi.fn(() => {
        throw new Error('already closed');
      }),
    };

    await build()(event);

    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('reads the WebSocket client at quit time, not at build time', async () => {
    // restartWebSocket() replaces the module-level binding; a handler that
    // captured the original reference would close a client that is already gone
    // and leave the live one connected.
    let current: { close: ReturnType<typeof vi.fn> } | null = null;
    const handler = buildBeforeQuitHandler({
      app,
      getWsClient: () => current,
      cleanupBrowser,
    });

    const replacement = { close: vi.fn() };
    current = replacement;
    await handler(event);

    expect(replacement.close).toHaveBeenCalledOnce();
  });
});
