# ADR-020: Approve-before-send is the default; autonomy is opt-in per opportunity and per action type

## Status

Accepted

## Context

The agent dispatches actions against the user's real LinkedIn account, visible to
real people. A default that sends without asking would make the first surprise a
public one.

The cited site is `frontend/src/features/opportunities/hooks/useAgent.ts:7`:

```ts
/** All agent surfaces are gated on this feature flag (ADR-020). */
```

The pro action service defaults a new per-opportunity agent config to approve
mode with no action type enabled:

```python
"""Safe-by-default per-opportunity agent config (ADR-020): approve mode, no
```

## Decision

The agent always _proposes_ typed actions. An outbound action dispatches only
after explicit user approval, unless a **specific opportunity** has been switched
into autonomous mode, and even then only for the action types the user enabled on
that opportunity. Autonomy is never a global default and never a global switch:
nothing fires unattended until an opportunity is deliberately configured `auto`
with that action type enabled.

## Consequences

- The safe state is the default state, and it is the state an unconfigured
  opportunity is in.
- A user who wants autonomy configures it per opportunity, which is more work but
  keeps the blast radius of a mistake to one opportunity.
- Approval is a pre-execution gate, so an unapproved proposal costs nothing to
  hold ([ADR-016](./ADR-016-action-items-are-the-durable-source-of-truth.md)).
- The global pause control is a _stop_, not an _enable_; it can only make the
  system safer than its per-opportunity configuration
  ([ADR-024](./ADR-024-agent-config-lives-on-agentcfg-items.md)).
