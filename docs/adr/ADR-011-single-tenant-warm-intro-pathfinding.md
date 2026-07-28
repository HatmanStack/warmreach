# ADR-011: Warm-intro pathfinding traverses the requester's own graph

## Status

Accepted

## Context

`warm_intro_paths_service` answers "which of my contacts can introduce me to
person X?". Its original breadth-first search discovered intermediaries by
looking up _reverse_ edges — every WarmReach user who also had an edge to a
candidate profile — so a returned path could route through a stranger's contact
list. That is a multi-tenant traversal of private relationship data, and it also
produced paths the requester could not actually use.

Once [ADR-010](./ADR-010-private-per-user-adjacency-store.md) made
contact-to-contact adjacency real inside the requester's own partition, the
cross-user hop had no reason to exist.

The cited site is
`backend/lambdas/shared/python/shared_services/warm_intro_paths_service.py:13`:

```python
in every returned path is a **real contact of the requesting user**, and every
read stays within ``PK=USER#{sub}`` — one user's inferred graph can never leak
into another's (ADR-011).
```

## Decision

The graph traversed is `you -> your contact -> ... -> target`. The first hop is a
forward edge (`PK=USER#{sub} SK=PROFILE#{contact}`) scored by that edge's
`relationshipScore`; every subsequent hop is an `ADJ#` adjacency edge scored by
its `strength`. All reads stay within `PK=USER#{sub}`. The cross-user reverse-edge
traversal is **removed, not extended**.

## Consequences

- Every intermediary in a returned path is a real contact of the requesting user,
  so the result is actionable rather than theoretical.
- No query in the pathfinder can read another user's partition, which is what
  makes the privacy property structural.
- Path quality now depends on adjacency coverage. A user with no collected
  mutual connections gets fewer paths than the old cross-user search returned —
  correctly, because those paths were not usable.
- Caps are unchanged: up to `max_hops` (3) hops, top `max_paths` (3) by average
  strength, a bounded queue, and a `truncated` flag when the search stops early.
