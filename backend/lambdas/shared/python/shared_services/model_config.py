"""Central registry of OpenAI model ids.

OpenAI retires models on a few months' notice, and the ids were previously
scattered across the LLM service, the LLM handler, the goal-intelligence
planner, and the agent's default config — so a forced migration meant hunting
call sites in four modules. They live here instead, and every one is
env-overridable so a retirement can be answered with a config change rather
than a code deploy.

This module lives in the shared layer specifically so the pro-only services
(`goal_intelligence_service`, `opportunity_action_service`) and the LLM Lambda
can all read the same values without importing each other — those two already
import one another, so hanging a shared constant off either creates a cycle.

Known retirement dates at time of writing:

* ``gpt-5.2`` — shuts down 2026-08-10 (was the default for every general op)
* ``o4-mini-deep-research`` — shuts down 2026-10-23

Cost note: OpenAI's suggested replacement for gpt-5.2 is ``gpt-5.6-sol`` at
USD 5.00/30.00 per 1M tokens, against gpt-5.2's 0.88/7.00. That would take a
full 3,000-op Pro grant from roughly USD 16 to USD 75 against USD 79 of
revenue. ``gpt-5.6-luna`` (1.00/6.00) is positioned by OpenAI for exactly this
kind of cost-sensitive, high-volume work and holds COGS near parity, so it is
the default here. Revisit if output quality proves insufficient.
"""

import logging
import os
from datetime import UTC, date, datetime

logger = logging.getLogger(__name__)

#: General-purpose generation: ideas, messages, icebreakers, synthesis.
MODEL_GENERAL = os.environ.get('OPENAI_MODEL_GENERAL', 'gpt-5.6-terra')

#: Analysis and classification: tone, message patterns, comments, summaries.
MODEL_ANALYSIS = os.environ.get('OPENAI_MODEL_ANALYSIS', 'gpt-5.6-terra')

#: Deep research. Retires 2026-10-23 — see MODEL_SHUTDOWNS. The alternative
#: o3-deep-research is USD 5.00/20.00 against this model's 1.00/4.00, so
#: migrating early costs 5x for no benefit. Every kickoff logs a countdown.
MODEL_DEEP_RESEARCH = os.environ.get('OPENAI_MODEL_DEEP_RESEARCH', 'o4-mini-deep-research')

#: Planner model for goal intelligence and the autonomous agent (ADR-022).
#: Reads PLANNER_MODEL, the name that already existed in
#: goal_intelligence_service, rather than introducing a second variable for
#: the same setting — two names for one knob is how an operator sets the one
#: that does nothing.
DEFAULT_PLANNER_MODEL = os.environ.get('PLANNER_MODEL', MODEL_ANALYSIS)

#: Announced OpenAI shutdown dates. A model listed here still works until its
#: date and then starts returning errors, so the value of this map is the
#: warning it drives — a retirement should be noticed from the logs well before
#: it becomes an outage. gpt-5.2 is kept after migration as a tripwire: if it
#: ever reappears via an env override, the warning fires.
MODEL_SHUTDOWNS: dict[str, date] = {
    'gpt-5.2': date(2026, 8, 10),
    'o4-mini': date(2026, 10, 23),
    'o4-mini-deep-research': date(2026, 10, 23),
}

#: Start warning this far ahead of a shutdown. Roughly a quarter, which is more
#: than enough lead time to schedule and ship a migration.
DEPRECATION_WARNING_WINDOW_DAYS = 120


def deprecation_notice(model: str, today: date | None = None) -> str | None:
    """Return a human-readable retirement notice for ``model``, or None.

    Returns a message once the shutdown is inside
    :data:`DEPRECATION_WARNING_WINDOW_DAYS`, and a blunter one once the date has
    passed — at which point calls are expected to be failing.
    """
    shutdown = MODEL_SHUTDOWNS.get(model)
    if not shutdown:
        return None

    days = (shutdown - (today or datetime.now(UTC).date())).days
    if days < 0:
        return (
            f'{model} was retired by OpenAI on {shutdown.isoformat()} '
            f'({-days} days ago); calls to it are expected to fail. '
            f'Set the matching OPENAI_MODEL_* env var to a current model.'
        )
    if days <= DEPRECATION_WARNING_WINDOW_DAYS:
        return (
            f'{model} is scheduled for retirement by OpenAI on '
            f'{shutdown.isoformat()} ({days} days away). Set the matching '
            f'OPENAI_MODEL_* env var to a current model before then.'
        )
    return None


def warn_if_deprecated(model: str, *, context: str = '') -> None:
    """Log a retirement warning for ``model`` if one applies.

    Deliberately not cached: these calls are seconds-long OpenAI operations, so
    one extra log line each is free, and a warning that appears on every use is
    far harder to ignore than one emitted once per cold start.
    """
    notice = deprecation_notice(model)
    if notice:
        logger.warning('%s%s', f'{context}: ' if context else '', notice)
