# ADR-016: `ACTION#` items are the durable source of truth; Step Functions drives transitions over them

## Status

Accepted

## Context

The autonomous opportunity agent proposes typed LinkedIn actions that may sit for
days awaiting human approval, a scheduled send window, or an out-of-band
confirmation. Two places could hold that lifecycle: Step Functions execution
history, or a DynamoDB item.

Execution history is not queryable by the UI, not a durable audit trail, and is
retained on the state machine's terms rather than the product's. The repository
already has a working precedent for the alternative in the deep-research durable
job: a status field, a reconciler tick, terminal states, and a filter that never
re-touches a terminal row.

The cited site is
`backend/lambdas/shared/python/shared_services/dynamodb_types.py:487`:

```python
class OpportunityActionItem(TypedDict, total=False):
    """USER#{sub} | ACTION#{uuid} — a durable proposed/executing agent action (ADR-016).
```

## Decision

Each proposed action is one DynamoDB item — `PK=USER#{sub}`, `SK=ACTION#{uuid}` —
carrying `opportunityId`, `type`, `targetProfileId`, `payload`, `rationale`,
`notBefore`, `dependsOn`, `status`, `idempotencyKey`, `executionArn`,
`commandId`, `statusHistory`, `planVersion`, `createdAt`, and `ttl`. The **item**,
not execution history, is what the UI, the audit trail, and the reconciler read.
Step Functions drives the lifecycle _over_ the item.

The status machine, terminal states in bold, is:

```text
pending_approval -> approved -> notBefore-wait -> dispatched-unconfirmed
    -> **confirmed** | **failed** | **expired** | **cancelled**
```

An execution exists only from `approved` onward: approval is a _pre-execution
gate_, never an in-execution task-token wait, so a proposal that is never
approved costs nothing to run. Transitions are validated against an explicit
transition table and written conditionally.

## Consequences

- The lifecycle survives Lambda restarts and state-machine redeploys.
- The UI reads actions with an ordinary query instead of the Step Functions API.
- Unapproved proposals incur zero execution cost, which is what makes
  propose-everything affordable.
- Any new status must be added to the transition table and to the terminal-state
  set together; a status that is terminal in one and not the other produces rows
  the reconciler sweeps forever.
