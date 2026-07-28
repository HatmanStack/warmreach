# ADR-021: Every operational guardrail is enforced server-side in one atomic gate-and-dispatch task

## Status

Accepted

## Context

The desktop client's rate limiter is constructed with no arguments, ignores
control-plane configuration, and falls back to fixed defaults. No quiet-hours
concept existed anywhere. Enforcing caps client-side would therefore mean
enforcing them in the one place the user can trivially bypass and the server
cannot observe.

Splitting the checks from the send is equally unsafe: any gap between "the cap
still allows this" and "the send happened" is a window in which a pause is
ignored or a cap is exceeded.

The cited site is `backend/lambdas/agent-action-task/gate_dispatch.py:5`:

```python
LinkedIn send is gated and metered (ADR-021). For one action it, in order:
```

## Decision

Caps, quiet hours, quota, and pause/kill are enforced **server-side**, in one
atomic gate-and-dispatch task that is the single choke point for every real send.
For one action, in order, it:

1. Re-reads the pause and kill flags **first**, immediately before the send, so a
   soft pause reliably stops anything not yet dispatched.
1. Checks quiet hours against the user's stored timezone.
1. Enforces the effective daily cap.
1. Reserves the `li-actions` quota bucket
   ([ADR-019](./ADR-019-li-actions-quota-bucket.md)).
1. Dispatches through the community-clean command core in-process
   ([ADR-009](./ADR-009-command-dispatch-community-clean-boundary.md)).

## Consequences

- A soft pause stops everything not yet dispatched. Actions already dispatched
  and unconfirmed cannot be recalled — physics, not a gap.
- The pause re-read must stay the _first_ step. Moving it earlier in the state
  machine, or caching it, reopens the window this ordering closes.
- The client's own rate limiter is not load-bearing for agent sends; it remains
  as a client-side courtesy only.
- Because the gate is the only choke point, any new dispatch path must route
  through it rather than reimplementing the checks.
