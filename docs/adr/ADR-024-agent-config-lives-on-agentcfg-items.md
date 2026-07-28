# ADR-024: Agent configuration lives on `AGENTCFG#` items, not on the shared `#SETTINGS` item

## Status

Accepted

## Context

The obvious home for global agent controls — pause, daily-cap override, planner
model — is the user's `#SETTINGS` item. But the `#SETTINGS` write path lives in
the `dynamodb-api` Lambda, which is an overlay-managed file present in both
editions. Adding pro-only settings keys there would fork the settings allowlist
across editions for a feature only one edition has.

There is also a shape problem: the opportunity list query is
`begins_with(SK, 'OPPORTUNITY#')`, so any sibling item must not collide with that
prefix.

The cited site is
`backend/lambdas/shared/python/shared_services/dynamodb_types.py:514`:

```python
class AgentConfigItem(TypedDict, total=False):
    """USER#{sub} | AGENTCFG#{opportunityId} or AGENTCFG#global (ADR-024).
```

## Decision

Per-opportunity agent configuration lives on `SK=AGENTCFG#{opportunityId}` and
the global controls (pause, daily-cap override, planner model) on
`SK=AGENTCFG#global`, both written through pro-only operations. The gate task
**reads** `#SETTINGS.timezone` for quiet-hours arithmetic and never writes
`#SETTINGS`.

The distinct `AGENTCFG#` prefix keeps these siblings out of the
`begins_with(SK, 'OPPORTUNITY#')` list query.

## Consequences

- The shared settings write path stays identical in both editions.
- Global controls are one item read, so the pause re-read in the gate is cheap
  enough to do immediately before every send
  ([ADR-021](./ADR-021-server-side-guardrails-in-one-atomic-gate.md)).
- Reading a stored control must go through the raw item rather than a defaulted
  view, or a default shadows the stored value
  ([ADR-022](./ADR-022-planner-model-is-env-configurable.md)).
- A future settings key that is genuinely shared still belongs on `#SETTINGS`;
  this ADR is about pro-only controls, not about all agent state.
