# ADR-015: Mutual-collection sync posture — public collector, private data and persistence

## Status

Accepted

## Context

The sensitive asset in the adjacency feature is the **inferred social-graph
data**, not the code that reads a page. The desktop client's scrape engine is
already fully public and verbatim-synced, and the profile-init service already
takes an optional injected scraper.

The alternative — making the collector a fully private capability invoked over a
private command route — would require overlaying the large, verbatim
`profileInitController.ts` and would contradict the decision to piggyback on
profile init ([ADR-014](./ADR-014-mutual-collection-piggybacks-on-profile-scrape.md)).

The cited site is
`client/src/domains/linkedin/services/mutualConnectionsCollector.ts:10`:

```ts
 * Verbatim/public per ADR-015, but inert until wired behind the consent gate
 * (Task 6). Degrades gracefully: if the surface is absent for a contact, or a
 * navigation fails, it returns an empty list and never throws into the
 * ingestion loop.
```

## Decision

The mutual-connections collector and its selectors are ordinary client modules
that sync verbatim to the community edition, injected through the same optional-slot
pattern as the existing local profile scraper. Privacy is enforced at the three
points that actually matter:

1. **The data** — every adjacency row is scoped to `PK=USER#{sub}`
   ([ADR-010](./ADR-010-private-per-user-adjacency-store.md)).
1. **The persistence op** — the community `edge-crud` overlay omits
   `upsert_adjacency`, so there is nowhere for a community build to write.
1. **The consent surface** — the opt-in card is a Pro frontend surface, so the
   community frontend never sends `collectMutuals`
   ([ADR-013](./ADR-013-mutual-connection-collection-consent.md)).

## Consequences

- The collector is present but dormant in the community edition: no consent
  surface sends the flag, and no route persists a result.
- No large verbatim client file needs an overlay, so the sync surface does not
  grow.
- Anyone reading the community source can see how collection would work. That is
  accepted: the code is a page reader, and the protected asset is the graph the
  Pro edition stores.
- If a community route to persist adjacency were ever added, point 2 would break
  and this ADR must be revisited before it is.
