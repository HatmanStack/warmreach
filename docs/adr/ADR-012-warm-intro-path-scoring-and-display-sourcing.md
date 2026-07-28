# ADR-012: Warm-intro path scoring and display fields are sourced from where they are written

## Status

Accepted

## Context

`_get_user_connections` projected **snake_case** `relationship_score`,
`first_name`, `last_name`, `position`, and `company` off the forward edge. The
forward edge stores **camelCase** `relationshipScore` and carries no name fields
at all — display names live on the shared `PROFILE#{id} #METADATA` item. Every
hop therefore silently defaulted to a score of 50 and every node name rendered
blank. The bug was invisible because the defaults are plausible.

The cited site is
`backend/lambdas/shared/python/shared_services/warm_intro_paths_service.py:188`:

```python
Reads the ``relationshipScore`` (camelCase) actually written on the
forward edge (ADR-012); a missing score defaults to
:data:`DEFAULT_RELATIONSHIP_SCORE`.
```

## Decision

- Read the user-to-contact relationship from the forward edge's **camelCase**
  `relationshipScore`; fall back to `DEFAULT_RELATIONSHIP_SCORE` only when the
  attribute is genuinely absent.
- Hydrate node display fields (`firstName`, `lastName`, `position`, `company`) by
  joining `PROFILE#{id} #METADATA` through the existing
  `edge_query_service.batch_get_profile_metadata`.
- Denormalise **only** a numeric `strength` onto adjacency rows for scoring.
  Mutable profile metadata is never duplicated onto an edge.

## Consequences

- Path scores reflect real relationship strength instead of a constant, so path
  ranking is meaningful.
- Display names come from one place, so a renamed contact is correct everywhere
  without a backfill.
- Hydration costs one batch read per path set. That is the deliberate trade
  against duplicating mutable fields onto every adjacency row.
- Any future field added to a path node must follow the same rule: score-like
  numbers may be denormalised, profile metadata must be joined.
