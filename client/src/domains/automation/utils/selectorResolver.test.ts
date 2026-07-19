import { describe, it, expect, vi } from 'vitest';
import { SelectorResolver, SelectorNotFoundError } from './selectorResolver.js';
import { SelectorRegistry } from './selectorRegistry.js';
import { createMockPage } from '../../../setupTests.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('SelectorResolver', () => {
  const mockRegistry: SelectorRegistry = {
    'test:point': [
      { strategy: 'aria', selector: 'button[aria-label="test"]' },
      { strategy: 'css', selector: '.test-btn' },
    ],
    'test:params': [{ strategy: 'aria', selector: 'button[aria-label="{paramName}"]' }],
  };

  it('resolves via first matching strategy', async () => {
    const page = createMockPage();
    const mockElement = {};
    page.$.mockResolvedValueOnce(mockElement);

    const resolver = new SelectorResolver(mockRegistry);
    const result = await resolver.resolve(page as any, 'test:point');

    expect(result).toBe(mockElement);
    expect(page.$).toHaveBeenCalledWith('button[aria-label="test"]');
    expect(page.$).toHaveBeenCalledTimes(1);
  });

  it('falls through to next strategy when first returns null', async () => {
    const page = createMockPage();
    const mockElement = {};
    page.$.mockResolvedValueOnce(null);
    page.$.mockResolvedValueOnce(mockElement);

    const resolver = new SelectorResolver(mockRegistry);
    const result = await resolver.resolve(page as any, 'test:point');

    expect(result).toBe(mockElement);
    expect(page.$).toHaveBeenCalledWith('button[aria-label="test"]');
    expect(page.$).toHaveBeenCalledWith('.test-btn');
    expect(page.$).toHaveBeenCalledTimes(2);
  });

  it('returns null when all strategies fail for resolve()', async () => {
    const page = createMockPage();
    page.$.mockResolvedValue(null);

    const resolver = new SelectorResolver(mockRegistry);
    const result = await resolver.resolve(page as any, 'test:point');

    expect(result).toBeNull();
    expect(page.$).toHaveBeenCalledTimes(2);
  });

  it('resolveRequired throws SelectorNotFoundError on total failure', async () => {
    const page = createMockPage();
    page.$.mockResolvedValue(null);

    const resolver = new SelectorResolver(mockRegistry);

    await expect(resolver.resolveRequired(page as any, 'test:point')).rejects.toThrowError(
      SelectorNotFoundError
    );
  });

  it('resolveAll returns results from first successful strategy', async () => {
    const page = createMockPage();
    const mockElements = [{}, {}];
    page.$$.mockResolvedValueOnce([]); // first fails
    page.$$.mockResolvedValueOnce(mockElements); // second succeeds

    const resolver = new SelectorResolver(mockRegistry);
    const result = await resolver.resolveAll(page as any, 'test:point');

    expect(result).toBe(mockElements);
    expect(page.$$).toHaveBeenCalledTimes(2);
  });

  it('resolveWithWait cascades through waitForSelector with timeouts', async () => {
    const page = createMockPage();
    const mockElement = {};
    page.waitForSelector.mockRejectedValueOnce(new Error('Timeout'));
    page.waitForSelector.mockResolvedValueOnce(mockElement);

    const resolver = new SelectorResolver(mockRegistry);
    const result = await resolver.resolveWithWait(page as any, 'test:point');

    expect(result).toBe(mockElement);
    expect(page.waitForSelector).toHaveBeenCalledTimes(2);
    expect(page.waitForSelector).toHaveBeenCalledWith(
      'button[aria-label="test"]',
      expect.any(Object)
    );
    expect(page.waitForSelector).toHaveBeenCalledWith('.test-btn', expect.any(Object));
  });

  it('throws on unknown interaction point', async () => {
    const page = createMockPage();
    const resolver = new SelectorResolver(mockRegistry);

    await expect(resolver.resolve(page as any, 'unknown:point')).rejects.toThrowError(
      /Unknown interaction point/
    );
  });

  it('resolveWithParams replaces placeholders', async () => {
    const page = createMockPage();
    const mockElement = {};
    page.$.mockResolvedValueOnce(mockElement);

    const resolver = new SelectorResolver(mockRegistry);
    const result = await resolver.resolveWithParams(page as any, 'test:params', {
      paramName: 'Save',
    });

    expect(result).toBe(mockElement);
    expect(page.$).toHaveBeenCalledWith('button[aria-label="Save"]');
  });

  describe('resolveVisibleWithWait', () => {
    const visibleHandle = () => ({
      boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 10, height: 10 }),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const hiddenHandle = () => ({
      boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 0, height: 0 }),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    it('returns the first on-screen (non-zero box) handle', async () => {
      const page = createMockPage();
      const handle = visibleHandle();
      page.$$.mockResolvedValue([handle]);

      const resolver = new SelectorResolver(mockRegistry);
      const result = await resolver.resolveVisibleWithWait(page as any, 'test:point', {
        timeout: 1000,
      });

      expect(result).toBe(handle);
    });

    it('skips (and disposes) zero-box handles, then takes a later visible one', async () => {
      const page = createMockPage();
      const hidden = hiddenHandle();
      const visible = visibleHandle();
      // First strategy yields only a hidden element; second yields a visible one.
      page.$$.mockResolvedValueOnce([hidden]).mockResolvedValueOnce([visible]);

      const resolver = new SelectorResolver(mockRegistry);
      const result = await resolver.resolveVisibleWithWait(page as any, 'test:point', {
        timeout: 1000,
      });

      expect(result).toBe(visible);
      expect(hidden.dispose).toHaveBeenCalled();
    });

    it('throws SelectorNotFoundError when nothing becomes visible before the timeout', async () => {
      const page = createMockPage();
      page.$$.mockResolvedValue([]);

      const resolver = new SelectorResolver(mockRegistry);
      await expect(
        resolver.resolveVisibleWithWait(page as any, 'test:point', { timeout: 50 })
      ).rejects.toThrowError(SelectorNotFoundError);
    });
  });

  describe('resolvePresentWithWait', () => {
    it('returns the first DOM-present match without a visibility check', async () => {
      const page = createMockPage();
      const el = {};
      page.$.mockResolvedValueOnce(el);

      const resolver = new SelectorResolver(mockRegistry);
      const result = await resolver.resolvePresentWithWait(page as any, 'test:point', {
        timeout: 1000,
      });

      expect(result).toBe(el);
    });

    it('throws SelectorNotFoundError when never present before the timeout', async () => {
      const page = createMockPage();
      page.$.mockResolvedValue(null);

      const resolver = new SelectorResolver(mockRegistry);
      await expect(
        resolver.resolvePresentWithWait(page as any, 'test:point', { timeout: 50 })
      ).rejects.toThrowError(SelectorNotFoundError);
    });
  });

  describe('self-heal telemetry', () => {
    it('records which strategy matched in the health report', async () => {
      const page = createMockPage();
      page.$.mockResolvedValueOnce({}); // preferred (aria) matches

      const resolver = new SelectorResolver(mockRegistry);
      await resolver.resolve(page as any, 'test:point');

      const entry = resolver
        .getSelectorHealthReport()
        .find((h) => h.interactionPoint === 'test:point');
      expect(entry?.lastMatchedStrategy).toBe('aria');
      expect(entry?.matchesByStrategy.aria).toBe(1);
      expect(entry?.fallbackMatches).toBe(0);
      expect(entry?.promotedStrategy).toBeNull();
    });

    it('promotes a fallback only after sustained wins, then tries it first', async () => {
      const page = createMockPage();
      const resolver = new SelectorResolver(mockRegistry);
      const health = () =>
        resolver.getSelectorHealthReport().find((h) => h.interactionPoint === 'test:point');

      // Preferred (aria) misses, fallback (css) matches. A single win is NOT
      // enough to promote — that would let a fluke reorder the cascade forever.
      page.$.mockResolvedValueOnce(null).mockResolvedValueOnce({});
      await resolver.resolve(page as any, 'test:point');
      expect(health()?.promotedStrategy).toBeNull();
      expect(health()?.fallbackMatches).toBe(1);

      // Two more consecutive fallback wins reach the promotion threshold (3).
      for (let i = 0; i < 2; i++) {
        page.$.mockReset();
        page.$.mockResolvedValueOnce(null).mockResolvedValueOnce({});
        await resolver.resolve(page as any, 'test:point');
      }
      expect(health()?.promotedStrategy).toBe('css');
      expect(health()?.fallbackMatches).toBe(3);

      // Next resolve tries the promoted css FIRST — a single $ call resolves it.
      page.$.mockReset();
      page.$.mockResolvedValueOnce({});
      const result = await resolver.resolve(page as any, 'test:point');
      expect(result).toBeTruthy();
      expect(page.$).toHaveBeenCalledTimes(1);
      expect(page.$).toHaveBeenCalledWith('.test-btn');
    });

    it('demotes a promoted strategy once the preferred selector matches again', async () => {
      const page = createMockPage();
      const resolver = new SelectorResolver(mockRegistry);

      // Promote css via three consecutive fallback wins.
      for (let i = 0; i < 3; i++) {
        page.$.mockReset();
        page.$.mockResolvedValueOnce(null).mockResolvedValueOnce({});
        await resolver.resolve(page as any, 'test:point');
      }
      expect(
        resolver.getSelectorHealthReport().find((h) => h.interactionPoint === 'test:point')
          ?.promotedStrategy
      ).toBe('css');

      // css is now tried first; make it MISS so the loop falls through to aria,
      // which matches — reclaiming the front and clearing the promotion.
      page.$.mockReset();
      page.$.mockResolvedValueOnce(null).mockResolvedValueOnce({});
      await resolver.resolve(page as any, 'test:point');

      expect(
        resolver.getSelectorHealthReport().find((h) => h.interactionPoint === 'test:point')
          ?.promotedStrategy
      ).toBeNull();
    });

    it('does not mutate the shared registry when promoting', async () => {
      const page = createMockPage();
      const resolver = new SelectorResolver(mockRegistry);

      // Three fallback wins → css promoted on the instance, not the registry array.
      for (let i = 0; i < 3; i++) {
        page.$.mockReset();
        page.$.mockResolvedValueOnce(null).mockResolvedValueOnce({});
        await resolver.resolve(page as any, 'test:point');
      }

      expect(mockRegistry['test:point'][0].strategy).toBe('aria');
    });

    it('records a failure when a required resolution exhausts the cascade', async () => {
      const page = createMockPage();
      page.$.mockResolvedValue(null);

      const resolver = new SelectorResolver(mockRegistry);
      await expect(resolver.resolveRequired(page as any, 'test:point')).rejects.toThrowError(
        SelectorNotFoundError
      );

      const entry = resolver
        .getSelectorHealthReport()
        .find((h) => h.interactionPoint === 'test:point');
      expect(entry?.failures).toBe(1);
      expect(entry?.lastFailureAt).toBeTruthy();
    });
  });
});
