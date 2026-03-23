"""Shared Lambda handler utilities.

Common helpers extracted from edge-crud, edge-insights, edge-pro, and ragstack
Lambda handlers to eliminate copy-paste duplication.
"""

import logging
import os

from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger(__name__)


def get_user_id(event):
    """Extract user ID from JWT, with DEV_MODE fallback."""
    user_id = extract_user_id(event)
    if user_id:
        return user_id
    if os.environ.get('DEV_MODE', '').lower() == 'true':
        return 'test-user-development'
    return None


def report_telemetry(quota_service, table, user_id: str, operation: str, count: int = 1):
    """Fire-and-forget usage telemetry. Never blocks the response.

    Args:
        quota_service: QuotaService instance (or None to skip).
        table: DynamoDB table resource for ensure_tier_exists.
        user_id: User identifier.
        operation: Operation name for metering.
        count: Usage count (default 1).
    """
    if not quota_service or not user_id:
        return
    try:
        from shared_services.monetization import ensure_tier_exists

        ensure_tier_exists(table, user_id)
        quota_service.report_usage(user_id, operation, count=count)
    except Exception as e:
        logger.warning(f'Telemetry report failed for {operation}: {e}')


def check_feature_gate(feature_flag_service, user_id: str, feature_key: str, event) -> dict | None:
    """Return a 403 response if the feature is gated, or None if access is allowed.

    Args:
        feature_flag_service: FeatureFlagService instance (or None to allow all).
        user_id: User identifier.
        feature_key: Feature key to check.
        event: API Gateway event for CORS response.
    """
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


def make_gated_handler(feature_flag_service_ref, feature_key, handler_fn):
    """Wrap a handler with feature gate check.

    Args:
        feature_flag_service_ref: FeatureFlagService instance OR a callable
            that returns one (for lazy resolution / testability).
        feature_key: Feature key to gate on.
        handler_fn: Handler function(body, user_id, event, edge_cache).
    """

    def wrapper(body, user_id, event, edge_cache):
        svc = feature_flag_service_ref() if callable(feature_flag_service_ref) else feature_flag_service_ref
        gate = check_feature_gate(svc, user_id, feature_key, event)
        if gate:
            return gate
        return handler_fn(body, user_id, event, edge_cache)

    return wrapper
