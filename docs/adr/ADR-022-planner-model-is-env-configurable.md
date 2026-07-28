# ADR-022: The planner model is configurable via environment

## Status

Accepted

## Context

The assessment model was a hardcoded string at three call sites and was never
overridden by a caller. OpenAI retires models on a few months' notice, so a
hardcoded id is a scheduled outage: the fix would be a code change and a redeploy
rather than a configuration change.

The cited site is
`backend/lambdas/shared/python/shared_services/model_config.py:45`:

```python
#: Planner model for goal intelligence and the autonomous agent (ADR-022).
#: Reads PLANNER_MODEL, the name that already existed in
#: goal_intelligence_service, rather than introducing a second variable for
#: the same setting — two names for one knob is how an operator sets the one
#: that does nothing.
DEFAULT_PLANNER_MODEL = os.environ.get('PLANNER_MODEL', MODEL_ANALYSIS)
```

## Decision

Model ids live in `shared_services/model_config.py` as env-overridable **roles**
rather than as literals at call sites. The planner role reads `PLANNER_MODEL` —
the variable name that already existed — and falls back to the analysis-role
model. Callers resolve the model by precedence: an explicit caller argument, then
the stored per-user agent configuration, then the env-backed default.

The same pattern applies to the agent's other tunables (timeouts, poll intervals,
confirmation windows), which are read from the environment with a literal
fallback and are cited in code as "ADR-022 style".

## Consequences

- A model retirement is a configuration change, not a redeploy.
- One knob has one name. Introducing a second variable for the same setting is
  explicitly rejected, because an operator will set the one that does nothing.
- The stored per-user planner model must be read from the raw configuration item,
  not from a defaulted view, or the default shadows the setting and the knob is
  dead.
- Every new model id must be added to the registry rather than to a call site,
  or it drops out of the countdown that warns about retirements.
