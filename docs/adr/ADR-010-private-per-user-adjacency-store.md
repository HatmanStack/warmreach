# ADR-010: Private per-user contact-to-contact adjacency store

## Status

Accepted

## Context

Nothing in the data model stored a PROFILE-to-PROFILE relationship. Every edge
was a spoke from the user (`PK=USER#{sub}`, `SK=PROFILE#{id}`), so the network
graph was an ego-star and the warm-intro pathfinder had to bridge through _other
WarmReach users_ to find an intermediary — a multi-tenant traversal over data
that belongs to different people.

Three shapes were considered: a `mutuals: []` list attribute on the forward edge
(no per-edge metadata, hits the 400 KB item cap, forces full-list rewrites, and
makes reverse lookups a scan); one row plus a new global secondary index (adds an
index _and_ an `AttributeDefinitions` entry to `backend/template.yaml`, an
overlay file whose community copy already carries a different index set); or
dedicated adjacency rows under the owning user's own partition.

The cited site is
`backend/lambdas/shared/python/shared_services/adjacency_service.py:10`:

```python
Load-bearing invariants (ADR-010):

1. All neighbors of any node ``n`` are retrievable with a single base-table query
   ``PK=USER#{user_id} AND begins_with(SK, 'ADJ#{n}#')`` -- no new GSI, no change
   to ``template.yaml``.
```

## Decision

Persist each undirected contact-to-contact edge under the **owning user's**
partition as two directed rows written in one `transact_write_items`:

```text
PK=USER#{sub}  SK=ADJ#{a}#{b}
PK=USER#{sub}  SK=ADJ#{b}#{a}
```

carrying `strength`, `source`, `observedAt`, `updatedAt`, and an optional
`mutualCount`. Three invariants are load-bearing — the exact sort-key spelling is
not:

1. Every neighbour of a node `n` is retrievable with a **single** base-table
   query `PK=USER#{sub} AND begins_with(SK, 'ADJ#{n}#')` — no new index and no
   new `AttributeDefinitions` entry.
1. Every read and write stays inside `PK=USER#{sub}`, so one user's inferred
   graph can never reach another's partition.
1. Writes are idempotent: `observedAt` is preserved with `if_not_exists` while
   `updatedAt`, `strength`, and `mutualCount` refresh on every write.

This mirrors the forward/reverse dual-write already proven in
`edge_status_service.upsert_status`.

## Consequences

- The mesh is leak-proof by construction rather than by filtering: a query that
  could return another user's data cannot be written, because every access path
  is anchored on the requesting user's partition key.
- Two rows are written per edge. That is the price of the single-query neighbour
  read and of avoiding index churn in an overlay-managed template.
- Adjacency rows are the only place tie strength is denormalised. Mutable profile
  metadata (names, position, company) is never copied onto them — see
  [ADR-012](./ADR-012-warm-intro-path-scoring-and-display-sourcing.md).
- The community edition ships the service but no persistence route; see
  [ADR-015](./ADR-015-mutual-collection-sync-posture.md).
