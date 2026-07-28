# ADR-009: Command-dispatch community-clean boundary

## Status

Accepted

## Context

Two send paths create a `COMMAND#` record and dispatch it to the user's
Electron agent over WebSocket: the manual gate (`linkedin-action-gate`,
`POST /linkedin-actions`) for user-initiated actions, and — in the pro edition —
the agent gate (`agent-action-task/gate_dispatch`) for autonomous actions. Both
must meter the shared `li-actions` quota bucket exactly once and must never
double-send a real LinkedIn action.

The command-creation path (rate-limit, create the record, dispatch over
WebSocket) is extracted into the shared `command_dispatch_core` module so both
gates call it **in-process** instead of paying a Lambda-to-Lambda network hop to
the `command-dispatch` Lambda. The `command-dispatch` handler (`POST /commands`)
calls the same core.

The invariant was originally cited in code as `ADR-8`. That marker collides with
`docs/adr/ADR-008` (browser-side timezone auto-detection), which is unrelated:
the code's informal `ADR-N` markers were the agent plan's decision log, a
different numbering scheme from this directory. This ADR gave the invariant a
real record and its citations use the three-digit `ADR-009` form. The two
neighbouring plan decisions — the pro/community sync boundary and the pro
`AGENTCFG#global` config — have since been promoted here too, as
[ADR-023](./ADR-023-pro-agent-logic-stays-out-of-verbatim-files.md) and
[ADR-024](./ADR-024-agent-config-lives-on-agentcfg-items.md); no short-form
numeric marker survives anywhere in the tree.

The core states the rule in its own docstring
(`backend/lambdas/shared/python/shared_services/command_dispatch_core.py`):

```python
"""Community-clean command-creation core.

Shared, agent- and quota-agnostic command-creation path extracted from the
``command-dispatch`` Lambda so callers can create a ``COMMAND#`` + WebSocket
dispatch **in-process** instead of paying a Lambda-to-Lambda network hop.
"""
```

## Decision

`command-dispatch` and the shared `command_dispatch_core` module stay
community-clean: they import nothing pro/agent/quota and contain no quota or
agent branching. Quota reservation lives in the gates, where the community/pro
split is already handled by the `monetization.py` overlay (a no-op `QuotaService`
stub in the community edition).

Each gate reserves the `li-actions` quota bucket first, then calls
`create_command(...)` in-process:

- The manual gate reserves for the user-initiated action, then calls the core.
- The pro agent gate reserves for the agent action, then performs its
  claim-before-send transition and calls the core.

Because both gates funnel into the same agent-agnostic core but each reserves
exactly once, a real LinkedIn action is metered exactly once and is never
double-sent.

Every decision the agent code cites now has a record in this directory, in the
three-digit `ADR-NNN` form. `docs/plans/` is working notes and is excluded from
the community edition, so it is not a citable target.

## Consequences

- The community edition never gains quota or agent logic in its command path:
  the core and `command-dispatch` are agent- and quota-agnostic, and the pro-only
  reservation is the sole difference — already isolated behind the monetization
  overlay, not a new network boundary.
- Moving the hop in-process removes a Lambda-to-Lambda invoke from the LinkedIn
  send hot path without changing the `(status_code, body)` contract
  (`200`+commandId dispatched, `409` no-agent, `429` rate-limited, `503`
  agent-disconnected).
- Any future change near the core must keep it free of pro/agent/quota imports;
  a static import check guards this in the core's test module.
- The `ADR-8` marker for this boundary was replaced in code by `ADR-009`, which
  resolves to this file. `scripts/check-doc-tables.py` now fails any citation
  that does not resolve, so the collision cannot recur.
