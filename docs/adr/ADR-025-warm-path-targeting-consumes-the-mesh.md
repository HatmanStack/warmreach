# ADR-025: Warm-path targeting consumes the adjacency mesh; the agent never re-implements it

## Status

Accepted

## Context

The autonomous agent wants to ground an outbound target in a real introduction
path rather than a cold approach. Pathfinding over contact-to-contact adjacency
already exists as a shared service
([ADR-010](./ADR-010-private-per-user-adjacency-store.md),
[ADR-011](./ADR-011-single-tenant-warm-intro-pathfinding.md)). A second
implementation inside the agent would drift from the first and would duplicate
the privacy invariants that make the mesh safe.

The cited site is
`backend/lambdas/shared/python/shared_services/goal_intelligence_service.py:67`:

```python
"""True only when B-1's warm-intro pathfinder + adjacency mesh have landed (ADR-025).
```

## Decision

The agent **consumes** the pathfinder's `find_paths` through an injected,
read-only dependency and never writes to the mesh or reimplements traversal. The
consumption is gated on the agent feature flag _and_ on a capability check that
the pathfinder and mesh are present, so the agent degrades to ungrounded
targeting rather than failing when they are not.

Returned paths arrive sorted best-first and capped, so the head of the list is
the best path and the agent does not re-rank.

## Consequences

- One implementation of pathfinding, one set of privacy invariants, one place to
  fix a scoring bug.
- The agent is read-only over the mesh, so an agent defect cannot corrupt
  adjacency data.
- Targeting quality depends on mesh coverage, which grows with consented
  collection ([ADR-013](./ADR-013-mutual-connection-collection-consent.md)).
- The capability check must stay, because the community edition ships an
  interface-compatible pathfinder stub that returns no paths.
