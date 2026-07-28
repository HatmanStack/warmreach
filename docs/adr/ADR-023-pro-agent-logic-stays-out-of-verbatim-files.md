# ADR-023: Pro agent logic stays out of community-verbatim files

## Status

Accepted

## Context

Pro code reaches the community edition through a one-way sync with two lists:
paths that are excluded outright, and paths that exist in both editions but
differ and are replaced by an overlay. Everything else syncs **verbatim** and
lands in both editions unchanged.

That makes a verbatim file the wrong place for pro logic twice over: it publishes
the logic, and it makes the community build depend on a service that edition does
not ship.

The cited site is `frontend/src/features/opportunities/types.ts:156`:

```ts
// from the community edition sync (ADR-023).
```

## Decision

No gating, metering, or agent logic is added to a file that syncs verbatim. In
particular the command-dispatch Lambda, the opportunity tagging service, and the
client's rate limiter and LinkedIn operation services stay agent-agnostic. The
underlying LinkedIn operations are fine community primitives; their quota
enforcement is not, and lives in the pro gate task.

New pro-only modules go in `exclude_paths`. Files that must exist in both
editions but differ — the SAM template, the client command router and its
schemas, the pro edge-crud hooks — get an overlay updated in the same commit as
the source.

## Consequences

- The community edition builds and tests without any pro module present.
- A pro feature that needs to touch a verbatim file must instead be reached
  through a seam the community edition can stub, which is why the monetization
  seam and the overlay set exist.
- Adding a pro import to a verbatim file is caught by the publication leak scan
  rather than by review alone.
- The boundary is checkable: the overlay-drift gate fails a source change whose
  overlay did not move with it.
