"""Shared transient-error retry wrapper for OpenAI ``responses.create`` calls.

Single source of truth for the retry policy so every paid OpenAI call — the
``LLMService`` operations in the LLM Lambda and the goal-intelligence
assessment/checklist calls used by both the LLM and analytics-insights
Lambdas — applies identical backoff. Previously the retry helper lived in
``llm/services/llm_service.py`` (LLM-Lambda-only); goal-intelligence runs in a
second Lambda that does not bundle ``services/``, so the policy is hoisted into
the shared layer here and re-used everywhere (DRY).

``openai`` is imported lazily inside the call so importing this module from a
Lambda that does not ship the ``openai`` package (it is only a dependency of
the LLM Lambda) does not fail at import time.
"""

import logging
import time

logger = logging.getLogger(__name__)

# Retry configuration for transient OpenAI errors.
# Connect/5xx/rate-limit errors get up to MAX_RETRIES attempts with exponential
# backoff starting at RETRY_BACKOFF_BASE_S and doubling each attempt. Keep total
# wall-clock well under the Lambda timeout (120s): with defaults the worst case
# is 2+4 = 6s of sleep across 3 attempts.
MAX_RETRIES = 3
RETRY_BACKOFF_BASE_S = 2.0


def _retryable_openai_errors() -> tuple[type[Exception], ...]:
    """Return the transient OpenAI error types, importing ``openai`` lazily."""
    import openai

    return (
        openai.APIConnectionError,
        openai.APITimeoutError,
        openai.RateLimitError,
        openai.InternalServerError,
    )


def retry_openai_call(fn, *, max_retries: int = MAX_RETRIES, sleep=None):
    """Invoke ``fn`` retrying transient OpenAI errors with exponential backoff.

    Retries on connection, timeout, rate-limit, and 5xx errors. Non-retryable
    errors (e.g. 400 BadRequestError, 401 AuthenticationError) propagate
    immediately. After ``max_retries`` attempts the last exception is raised.

    ``sleep`` resolves to ``time.sleep`` at call time when unset, so tests can
    monkey-patch ``time.sleep`` without re-importing.
    """
    if max_retries < 1:
        raise ValueError('max_retries must be >= 1')
    retryable = _retryable_openai_errors()
    _sleep = sleep if sleep is not None else time.sleep
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            return fn()
        except retryable as e:
            last_exc = e
            if attempt == max_retries - 1:
                raise
            backoff = RETRY_BACKOFF_BASE_S * (2**attempt)
            logger.warning(
                'Transient OpenAI error on attempt %s/%s: %s; retrying in %.1fs',
                attempt + 1,
                max_retries,
                type(e).__name__,
                backoff,
            )
            _sleep(backoff)
    # Unreachable: loop either returns or raises.
    if last_exc is not None:
        raise last_exc
    raise RuntimeError('retry helper exited without result')
