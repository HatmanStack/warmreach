# ADR-018: Confirmation is out-of-band; dependent actions are confirmation-gated

## Status

Accepted

## Context

The desktop client's success signals are not trustworthy as evidence that a real
LinkedIn action landed: several are hardcoded optimistic values, and message
delivery is inferred from timing. Only the follow operation genuinely re-checks
the resulting page state.

Treating a dispatch result as confirmation would let the agent message someone it
never actually connected to — the worst available failure, because it is visible
to the other person.

The cited site is `backend/lambdas/edge-crud/lambda_function.py:65`:

```python
# Edge statuses that mean the connection became mutual/accepted — the out-of-band
# signal (ADR-018) that confirms a dispatched agent `connect` action.
```

## Decision

On dispatch an action becomes `dispatched-unconfirmed`. It advances to
`confirmed` only on an **independent** signal:

- `follow` — the genuine follow-status DOM re-check result.
- `connect` — a later connection-status lifecycle event showing the connection
  became mutual.
- `message` — a best-effort honest client delivery signal where one is
  achievable, otherwise a later conversation or lifecycle signal, otherwise a
  confirmation timeout into `expired`.

An action whose `dependsOn` names a prior action does not dispatch until that
prerequisite reaches `confirmed`.

## Consequences

- A dependent action can never fire on a false success.
- Some actions sit in `dispatched-unconfirmed` until a timeout, which is honest
  rather than optimistic; the reconciler is what moves them.
- The confirmation sources are per-action-type. A new action type must name its
  independent signal, or it can never leave `dispatched-unconfirmed`.
- An already-dispatched action cannot be recalled. That is physics, not a gap —
  see [ADR-021](./ADR-021-server-side-guardrails-in-one-atomic-gate.md).
