# ADR-002: Conversion-likelihood classification rules (HIGH/MEDIUM/LOW)

## Status

Accepted

## Context

The connection pipeline needs a cheap, deterministic way to triage new profiles so the UI can surface the ones most likely to convert without waiting on an LLM scoring pass.

The cited site is `backend/lambdas/shared/python/models/enums.py:25`:

```python
def classify_conversion_likelihood(profile, edge) -> ConversionLikelihood:
    """
    Classify conversion likelihood based on profile completeness and edge data.

    Classification Rules (per ADR-002):
    - HIGH: Has headline AND summary AND (added < 7 days) AND (attempts == 0)
    - LOW: Missing headline OR missing summary OR (attempts > 2)
    - MEDIUM: Everything else
    """
```

## Decision

Classification is a pure function of profile completeness (`headline`, `summary`) and edge state (`added_days_ago`, `attempt_count`). No LLM, no database call, no tunable weights. Thresholds are constants in the enum module.

## Consequences

- Triage is instantaneous and free, runnable in tight loops without quota impact.
- The rules are explicit and inspectable. Any disagreement with a classification is traceable to one of the three input fields.
- The thresholds (7 days, attempt count 0 / 2) are deliberately coarse. A future model-based scorer, if introduced, must not reuse this function's name — add a parallel function so the fast-path stays available.
- Changing a threshold is a user-visible change and requires a new ADR or a superseding version of this one.
