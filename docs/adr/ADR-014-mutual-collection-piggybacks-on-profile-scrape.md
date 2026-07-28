# ADR-014: Mutual collection piggybacks on the existing profile scrape and its pacing

## Status

Accepted

## Context

A dedicated crawl over a user's contacts to build the adjacency mesh would be a
bulk-collection pass: a new traffic pattern, a new pacing story, and a new abort
story. The ingestion path already has all three — a daily scrape cap, a burst
throttle, and a backoff/abort controller driven by response signals — and it
already visits exactly the contacts whose mutual connections are wanted.

The cited site is `client/src/domains/profile/services/profileScraping.ts:126`:

```ts
// Consented mutual-connections collection, piggybacked on this
// scrape (ADR-014). A strict no-op unless collectMutuals is set and a
// collector is injected; never throws into the ingestion loop.
await collectMutualConnections(service, connectionProfileId, state);
```

## Decision

Collection happens **inside the existing profile-scrape gate** — only when the
contact is already being scraped, i.e. within the `needsScrape` branch of
`processConnection`. It therefore inherits, unchanged:

- the daily scrape cap (`canScrapeToday` / `incrementDailyScrapeCount`),
- the `BurstThrottleManager` pacing already enforced in
  `profileBatchProcessing.ts`,
- the signal-detector and backoff abort path (429/503/checkpoint), and
- import-mode bracketing around the connection lists.

There is no bulk crawl and no separate scheduler. Profile staleness is the
staleness mechanism; a dedicated per-contact collection marker is deferred.

## Consequences

- Collection adds at most one extra navigation per contact that is already being
  scraped, and every existing rate-limit and abort primitive applies to it for
  free.
- Coverage grows with ingestion rather than on its own schedule, so the mesh
  fills in gradually.
- A collection or persistence failure is logged and swallowed: it must never
  throw into the ingestion loop, because a failed side-quest must not fail the
  profile init the user actually asked for.
- Because staleness is inherited from the profile scrape, a contact whose profile
  is fresh is not revisited for mutuals either.
