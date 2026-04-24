"""Shared error mapping for LLMService operations.

Previously eleven try/except blocks in ``llm_service.py`` each mapped
OpenAI / generic exceptions to the project's typed errors. This module
exposes a single ``map_llm_exception`` helper that callers (and a thin
in-module ``wrap_llm_errors`` decorator) use to keep the mapping in one
place.
"""

from __future__ import annotations

import logging

import openai
from errors.exceptions import ExternalServiceError, ServiceError, ValidationError

logger = logging.getLogger(__name__)

_OPENAI_ERRORS: tuple[type[Exception], ...] = (
    openai.APIError,
    openai.APITimeoutError,
    openai.RateLimitError,
)

_PROJECT_TYPED_ERRORS: tuple[type[Exception], ...] = (
    ValidationError,
    ExternalServiceError,
    ServiceError,
)


def map_llm_exception(exc: BaseException, *, operation: str, user_message: str, service: str = 'OpenAI') -> Exception:
    """Return the ExternalServiceError / ServiceError / original typed error
    that represents ``exc`` in the project's error vocabulary.

    Caller: ``raise map_llm_exception(e, operation='generate_ideas', ...) from e``.
    """
    if isinstance(exc, _PROJECT_TYPED_ERRORS):
        # Already a typed project error; propagate unchanged.
        return exc  # type: ignore[return-value]
    if isinstance(exc, _OPENAI_ERRORS):
        logger.error('OpenAI API error in %s: %s', operation, exc)
        return ExternalServiceError(
            message=user_message,
            service=service,
            original_error=str(exc),
        )
    logger.error('Error in %s: %s', operation, exc)
    return ServiceError(message=user_message)


__all__ = ['map_llm_exception']
