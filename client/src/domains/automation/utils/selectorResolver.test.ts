import { describe, it, expect } from 'vitest';
import { SelectorResolver, SelectorNotFoundError } from './selectorResolver.js';
import { SelectorRegistry } from './selectorRegistry.js';
import { createMockPage } from '../../../setupTests.js';

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
});
