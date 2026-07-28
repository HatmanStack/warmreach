# ADR-017: `ACTION#` access patterns overload GSI1; no new index

## Status

Accepted

## Context

The agent UI queries a user's actions by status and wants them in due-time order
within each status. The base table's sort key (`ACTION#{uuid}`) sorts by an
opaque identifier, so it cannot serve either need.

GSI1 (`GSI1PK`/`GSI1SK`, projection `ALL`) is the repository's generic
overloadable index and is already used this way by the edge-status and edge-query
services. The inverted index (`SK` hash / `PK` range) cannot group by status. A
new index would add both an index and an `AttributeDefinitions` entry to
`backend/template.yaml`, which is an overlay-managed file.

The cited site is
`backend/lambdas/shared/python/shared_services/dynamodb_types.py:489`:

```python
GSI1 keys (ADR-017): GSI1PK=USER#{sub}#ACTIONS, GSI1SK={status}#{notBefore}#{uuid}.
```

## Decision

`ACTION#` items set:

- `GSI1PK = USER#{sub}#ACTIONS` — an isolated per-user action partition, so
  action rows never mingle with the edge-status rows that use
  `GSI1PK = USER#{sub}`.
- `GSI1SK = {status}#{notBefore_iso}#{uuid}` — `begins_with(GSI1SK, '{status}#')`
  serves the per-status queries, and ISO-8601 sorts lexically, so due-time
  ordering within a status is free.

The **cross-user** reconciler sweep does not use GSI1 at all — its partition key
is per-user. It uses a segmented parallel scan with a `begins_with(SK, 'ACTION#')`
filter, exactly like the research reconciler.

## Consequences

- No template change, no new index cost, and no overlay churn.
- A status transition rewrites `GSI1SK`, which is an index update rather than a
  new item — the intended cost of encoding status in a sort key.
- The isolated `#ACTIONS` partition suffix is load-bearing. Dropping it would
  make every edge-status query read action rows.
- The reconciler's cost scales with table size rather than with backlog size.
  That is bounded separately by a deadline budget and a resume cursor, not by
  this index.
