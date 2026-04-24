# ADR-005: Followup default thresholds (min score, max recency, limit)

## Status

Accepted

## Context

The weekly digest's followup section needs to surface cold connections worth re-engaging. Without defaults, every caller reinvents a threshold, and the digest content drifts per user.

The cited site is `backend/lambdas/digest-per-user/services/followup_service.py:10`:

```python
# Default thresholds (ADR-005)
DEFAULT_MIN_SCORE = 40
DEFAULT_MAX_RECENCY = 30
DEFAULT_LIMIT = 10
```

## Decision

The followup service ships three module-level constants:

- `DEFAULT_MIN_SCORE = 40` — minimum relationship score for a connection to be considered worth re-engaging.
- `DEFAULT_MAX_RECENCY = 30` — maximum days since last activity; older connections are treated as cold.
- `DEFAULT_LIMIT = 10` — maximum suggestions per digest.

Callers may override per-request, but the defaults are the production contract.

## Consequences

- Per-user digests are uniform unless a caller explicitly overrides.
- Tuning is a one-line change in this module, reviewable in isolation.
- Any override from the request layer must be validated at the edge; the service trusts its inputs.
- If user feedback shows the defaults are wrong for the majority case, update the constants and record the rationale in a commit body referencing this ADR.
