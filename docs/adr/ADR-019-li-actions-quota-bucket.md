# ADR-019: Real LinkedIn actions meter against a distinct `li-actions` bucket

## Status

Accepted

## Context

The `USAGE#` counters key only on period and date (`USAGE#daily#{YYYY-MM-DD}`,
`USAGE#monthly#{YYYY-MM}`) with no per-operation dimension, and despite the
`linkedin_interactions` naming they are consumed **only by LLM operations**. The
name predates the split and has already misled a reader.

Reusing that counter for real agent-dispatched LinkedIn actions would make one
number mean two unrelated things, and would let LLM usage exhaust the budget that
protects the user's actual LinkedIn account.

The cited site is
`backend/lambdas/shared/python/shared_services/quota_service.py:17`:

```python
# ADR-019: real agent-dispatched LinkedIn actions meter against a bucket distinct
# from the LLM-consumed ``linkedin_interactions`` counter, with its own tier
# quota fields. Defaults apply when the tier item omits them.
```

## Decision

Real LinkedIn actions meter against a distinct bucket with its own sort-key
segment — `USAGE#li-actions#daily#{date}` and `USAGE#li-actions#monthly#{month}` —
and its own tier quota fields (`daily_li_actions`, `monthly_li_actions`).
Metering uses the reserve, dispatch, release-on-failure idiom inside the atomic
gate-and-dispatch task ([ADR-021](./ADR-021-server-side-guardrails-in-one-atomic-gate.md)),
never in the community-clean command core
([ADR-009](./ADR-009-command-dispatch-community-clean-boundary.md)).

## Consequences

- LLM usage and real-action usage cannot exhaust each other.
- The two names must be read carefully: `daily/monthly_linkedin_interactions` is
  the LLM counter, `daily/monthly_li_actions` is the real-action counter. The
  documented usage keyspace in `docs/ARCHITECTURE.md` spells both out.
- The manual send gate and the agent gate share the bucket, so a user's manual
  and autonomous sends are capped together — which is the point, since LinkedIn
  sees one account.
- Defaults apply when the tier item omits the fields, so an older tier row does
  not fail open.
