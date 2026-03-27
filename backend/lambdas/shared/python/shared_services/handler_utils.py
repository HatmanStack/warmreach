"""Shared handler utilities for Lambda function routing and gating.

Extracted from the monolithic edge-processing handler to be shared across
the edge-crud, ragstack-ops, and analytics-insights Lambda functions.
"""

import logging
import os
from typing import Any

from shared_services.monetization import ensure_tier_exists
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger(__name__)


def sanitize_request_context(request_context: dict | None) -> dict:
    """Remove sensitive fields from requestContext before logging."""
    if not request_context:
        return {}
    sanitized = {}
    sensitive_keys = {'authorizer', 'authorization'}
    for key, value in request_context.items():
        if key.lower() in sensitive_keys:
            sanitized[key] = '[REDACTED]'
        elif isinstance(value, dict):
            sanitized[key] = {
                k: '[REDACTED]'
                if any(s in k.lower() for s in ('token', 'authorization', 'claim', 'secret', 'credential'))
                else v
                for k, v in value.items()
            }
        else:
            sanitized[key] = value
    return sanitized


def get_user_id(event: dict) -> str | None:
    """Extract user ID from JWT, with DEV_MODE fallback."""
    user_id = extract_user_id(event)
    if user_id:
        return user_id
    if os.environ.get('DEV_MODE', '').lower() == 'true':
        return 'test-user-development'
    return None


def report_telemetry(quota_service: Any, table: Any, user_id: str, operation: str, count: int = 1) -> None:
    """Fire-and-forget usage telemetry. Never blocks the response."""
    if not quota_service or not user_id:
        return
    try:
        ensure_tier_exists(table, user_id)
        quota_service.report_usage(user_id, operation, count=count)
    except Exception as e:
        logger.warning(f'Telemetry report failed for {operation}: {e}')


def check_feature_gate(feature_flag_service: Any, user_id: str, feature_key: str, event: dict) -> dict | None:
    """Return a 403 response if the feature is gated, or None if access is allowed."""
    if feature_flag_service:
        try:
            flags = feature_flag_service.get_feature_flags(user_id)
            if not flags.get('features', {}).get(feature_key, False):
                return api_response(
                    403, {'error': 'Feature not available on current plan', 'code': 'FEATURE_GATED'}, event
                )
        except Exception:
            logger.error(f'Feature flag check failed for {feature_key}, denying request')
            return api_response(503, {'error': 'Feature availability check failed'}, event)
    return None


def gated_handler(feature_flag_service: Any, feature_key: str, handler_fn: Any) -> Any:
    """Wrap a handler with feature gate check. Returns a handler that checks the gate first."""

    def wrapper(body, user_id, event, edge_cache):
        gate = check_feature_gate(feature_flag_service, user_id, feature_key, event)
        if gate:
            return gate
        return handler_fn(body, user_id, event, edge_cache)

    return wrapper


def lazy_gated_handler(get_service: Any, feature_key: str, handler_fn: Any) -> Any:
    """Like gated_handler but resolves the feature flag service at call time (late binding).

    Use this when building HANDLERS dicts at module level where the service
    reference may be patched during testing.
    """

    def wrapper(body, user_id, event, edge_cache):
        gate = check_feature_gate(get_service(), user_id, feature_key, event)
        if gate:
            return gate
        return handler_fn(body, user_id, event, edge_cache)

    return wrapper


def get_user_edges_cached(edge_data_service: Any, user_id: str, cache: dict) -> list:
    """Return cached edges or query and cache them. Cache is per-invocation."""
    if user_id not in cache:
        cache[user_id] = edge_data_service.query_all_edges(user_id)
    return cache[user_id]
