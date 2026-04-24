"""Shared handler utilities for Lambda function routing and gating.

Extracted from the monolithic edge-processing handler to be shared across
the edge-crud, ragstack-ops, and analytics-insights Lambda functions.
"""

import logging
import os
from typing import Any

from shared_services.monetization import ensure_tier_exists
from shared_services.protocols import (
    FeatureFlagServiceProto,
    HandlerFn,
    QuotaServiceProto,
    ServiceResolver,
)
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger(__name__)

_DEV_MODE_WARNED = False


def parse_days(body: dict | None, default: int = 30, max_: int = 365) -> int:
    """Parse a ``days`` field from an incoming JSON body with clamping.

    Handles missing keys, non-integer strings, and out-of-range values. Used
    across analytics-insights handlers where the same three-line coercion was
    duplicated 25+ times.

    Args:
        body: Request body (or None / missing, treated as empty).
        default: Value returned when the field is missing, non-numeric, or ``<= 0``.
        max_: Upper clamp; values above this return ``max_``.
    """
    raw = (body or {}).get('days')
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    if value <= 0:
        return default
    return min(value, max_)


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
        global _DEV_MODE_WARNED
        if not _DEV_MODE_WARNED:
            logger.warning(
                'DEV_MODE=true — unauthenticated requests are being accepted as test-user-development. '
                'This MUST NOT be set in production.'
            )
            _DEV_MODE_WARNED = True
        return 'test-user-development'
    return None


def report_telemetry(
    quota_service: QuotaServiceProto | None, table: Any, user_id: str, operation: str, count: int = 1
) -> None:
    """Fire-and-forget usage telemetry. Never blocks the response."""
    if not quota_service or not user_id:
        return
    try:
        ensure_tier_exists(table, user_id)
        quota_service.report_usage(user_id, operation, count=count)
    except Exception:
        logger.exception('Telemetry report failed for %s', operation)


def check_feature_gate(
    feature_flag_service: FeatureFlagServiceProto | None, user_id: str, feature_key: str, event: dict
) -> dict | None:
    """Return a 403 response if the feature is gated, or None if access is allowed."""
    if feature_flag_service:
        try:
            flags = feature_flag_service.get_feature_flags(user_id)
            if not flags.get('features', {}).get(feature_key, False):
                return api_response(
                    403, {'error': 'Feature not available on current plan', 'code': 'FEATURE_GATED'}, event
                )
        except Exception:
            logger.exception('Feature flag check failed for %s, denying request', feature_key)
            return api_response(503, {'error': 'Feature availability check failed'}, event)
    return None


def gated_handler(
    feature_flag_service: FeatureFlagServiceProto | None, feature_key: str, handler_fn: HandlerFn
) -> HandlerFn:
    """Wrap a handler with feature gate check. Returns a handler that checks the gate first."""

    def wrapper(body, user_id, event, edge_cache):
        gate = check_feature_gate(feature_flag_service, user_id, feature_key, event)
        if gate:
            return gate
        return handler_fn(body, user_id, event, edge_cache)

    return wrapper


def lazy_gated_handler(get_service: ServiceResolver, feature_key: str, handler_fn: HandlerFn) -> HandlerFn:
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


def parallel_scan(
    table: Any,
    *,
    total_segments: int = 4,
    scan_kwargs: dict | None = None,
) -> list[dict]:
    """Run a DynamoDB parallel scan and return all items across segments.

    Fans out ``total_segments`` concurrent scans using a thread pool. Each
    worker handles pagination for its own segment. The boto3 Table resource
    is documented as thread-safe for concurrent request calls against the
    same botocore client, so sharing ``table`` across threads is safe.

    Args:
        table: boto3 DynamoDB Table resource.
        total_segments: Number of parallel segments. 4 is a safe default for
            Lambda memory footprints; raise for very large tables.
        scan_kwargs: Additional kwargs passed through to ``table.scan``
            (e.g. ``FilterExpression``, ``ProjectionExpression``,
            ``ExpressionAttributeValues``, ``ExpressionAttributeNames``).

    Returns:
        Flat list of items collected from every segment.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    base_kwargs = dict(scan_kwargs or {})
    # Segment and TotalSegments are managed by the helper; reject caller values
    # to avoid silently ignoring a misconfiguration.
    base_kwargs.pop('Segment', None)
    base_kwargs.pop('TotalSegments', None)

    def _scan_segment(segment: int) -> list[dict]:
        items: list[dict] = []
        params = {**base_kwargs, 'Segment': segment, 'TotalSegments': total_segments}
        while True:
            response = table.scan(**params)
            items.extend(response.get('Items', []))
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
            params['ExclusiveStartKey'] = last_key
        return items

    all_items: list[dict] = []
    with ThreadPoolExecutor(max_workers=total_segments) as executor:
        futures = [executor.submit(_scan_segment, i) for i in range(total_segments)]
        for future in as_completed(futures):
            all_items.extend(future.result())
    return all_items


def make_goal_intelligence_service(table: Any) -> Any:
    """Construct a GoalIntelligenceService with its dependency chain.

    Shared factory used by both the LLM and analytics-insights Lambdas to avoid
    duplicating the OpportunityService → WebSocketService → NotificationService
    → GoalIntelligenceService construction graph.
    """
    from shared_services.goal_intelligence_service import GoalIntelligenceService
    from shared_services.notification_service import NotificationService
    from shared_services.opportunity_service import OpportunityService
    from shared_services.websocket_service import WebSocketService

    opp_service = OpportunityService(table)
    ws_endpoint = os.environ.get('WEBSOCKET_ENDPOINT', '')
    ws_service = WebSocketService(table, ws_endpoint) if ws_endpoint else None
    notification_service = NotificationService(table, ws_service) if table else None
    return GoalIntelligenceService(table, opp_service, notification_service=notification_service)
