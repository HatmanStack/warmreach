import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { MutualConnectionsCollector } from './mutualConnectionsCollector.js';

// A shared-connections results list with three cards. jane-doe appears twice
// (must dedupe); the contact "acme-alice" appears as a card (must be skipped).
const SHARED_CONNECTIONS_HTML = `
<html><body>
  <div class="search-results-container">
    <ul class="reusable-search__entity-result-list" role="list">
      <li class="reusable-search__result-container">
        <a class="app-aware-link" href="https://www.linkedin.com/in/jane-doe/">Jane Doe</a>
        <a class="app-aware-link" href="/in/jane-doe/overlay/">message</a>
      </li>
      <li class="reusable-search__result-container">
        <a class="app-aware-link" href="/in/john-smith?miniProfileUrn=abc">John Smith</a>
      </li>
      <li class="reusable-search__result-container">
        <a class="app-aware-link" href="/in/jane-doe/">Jane Doe (dup)</a>
      </li>
      <li class="reusable-search__result-container">
        <a class="app-aware-link" href="/in/acme-alice/">Acme Alice (the contact)</a>
      </li>
    </ul>
  </div>
</body></html>
`;

// A page where the shared-connections surface simply is not present.
const NO_SURFACE_HTML = `
<html><body><main><p>No results found</p></main></body></html>
`;

describe('MutualConnectionsCollector', () => {
  let collector: MutualConnectionsCollector;
  let mockPage: { goto: ReturnType<typeof vi.fn>; content: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn(),
    };
    collector = new MutualConnectionsCollector(mockPage as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    const result = promise;
    await vi.advanceTimersByTimeAsync(10000);
    return result;
  }

  it('returns per-card shared connections, deduped and excluding the contact', async () => {
    mockPage.content.mockResolvedValueOnce(SHARED_CONNECTIONS_HTML);

    const result = await runWithTimers(collector.collectSharedConnections('acme-alice'));

    expect(result.map((r) => r.profileId)).toEqual(['jane-doe', 'john-smith']);
  });

  it('navigates exactly once to a URL derived from the contact', async () => {
    mockPage.content.mockResolvedValueOnce(SHARED_CONNECTIONS_HTML);

    await runWithTimers(collector.collectSharedConnections('acme-alice'));

    expect(mockPage.goto).toHaveBeenCalledTimes(1);
    const url = mockPage.goto.mock.calls[0][0] as string;
    expect(url).toContain('/search/results/people/');
    expect(url).toContain(encodeURIComponent(JSON.stringify(['acme-alice'])));
  });

  it('returns an empty list (no throw) when the surface is absent', async () => {
    mockPage.content.mockResolvedValueOnce(NO_SURFACE_HTML);

    const result = await runWithTimers(collector.collectSharedConnections('acme-alice'));

    expect(result).toEqual([]);
  });

  it('returns an empty list (no throw) when navigation fails', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('nav timeout'));

    const result = await runWithTimers(collector.collectSharedConnections('acme-alice'));

    expect(result).toEqual([]);
  });

  it('returns an empty list for an invalid contact id without navigating', async () => {
    const result = await collector.collectSharedConnections('bad id/with/slashes');

    expect(result).toEqual([]);
    expect(mockPage.goto).not.toHaveBeenCalled();
  });
});
