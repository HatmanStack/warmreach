"""LinkedIn Edge Management Lambda - Routes edge and RAGStack operations."""

import json
import logging
import os

import boto3
from errors.exceptions import AuthorizationError, ExternalServiceError, NotFoundError, ServiceError, ValidationError
from shared_services.analytics_service import AnalyticsService
from shared_services.cluster_detection_service import ClusterDetectionService
from shared_services.edge_data_service import EdgeDataService
from shared_services.insight_cache_service import InsightCacheService
from shared_services.monetization import FeatureFlagService, QuotaService, ensure_tier_exists
from shared_services.priority_inference_service import PriorityInferenceService
from shared_services.ragstack_proxy_service import RAGStackProxyService
from shared_services.relationship_scoring_service import RelationshipScoringService
from shared_services.reply_probability_service import ReplyProbabilityService
from shared_services.request_utils import api_response, extract_user_id
from shared_services.send_time_service import SendTimeService
from shared_services.warm_intro_paths_service import WarmIntroPathsService

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration and clients
table = boto3.resource('dynamodb').Table(os.environ['DYNAMODB_TABLE_NAME'])
RAGSTACK_GRAPHQL_ENDPOINT = os.environ.get(
    'RAGSTACK_GRAPHQL_ENDPOINT', ''
)  # Optional: RAGStack integration disabled when empty
RAGSTACK_API_KEY = os.environ.get('RAGSTACK_API_KEY', '')  # Optional: RAGStack integration disabled when empty

# Module-level clients for warm container reuse
_ragstack_client = None
_ingestion_service = None
_quota_service = QuotaService(table) if table else None
_feature_flag_service = FeatureFlagService(table) if table else None
_analytics_service = AnalyticsService(table) if table else None
_priority_inference_service = PriorityInferenceService()
_reply_probability_service = ReplyProbabilityService()
_cluster_detection_service = ClusterDetectionService()
_send_time_service = SendTimeService()
_scoring_service = RelationshipScoringService()
_warm_intro_paths_service = WarmIntroPathsService(table)

if RAGSTACK_GRAPHQL_ENDPOINT and RAGSTACK_API_KEY:
    from shared_services.ingestion_service import IngestionService
    from shared_services.ragstack_client import RAGStackClient

    _ragstack_client = RAGStackClient(RAGSTACK_GRAPHQL_ENDPOINT, RAGSTACK_API_KEY)
    _ingestion_service = IngestionService(_ragstack_client)

# Three decomposed services replace the monolithic EdgeService
_edge_data_service = EdgeDataService(
    table=table,
    ragstack_endpoint=RAGSTACK_GRAPHQL_ENDPOINT,
    ragstack_api_key=RAGSTACK_API_KEY,
    ragstack_client=_ragstack_client,
    ingestion_service=_ingestion_service,
)
_insight_cache_service = InsightCacheService(table=table)
_ragstack_proxy_service = RAGStackProxyService(
    ragstack_client=_ragstack_client,
    ingestion_service=_ingestion_service,
    table=table,
    edge_data_service=_edge_data_service,
)


def _sanitize_request_context(request_context):
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


def _get_user_id(event):
    """Extract user ID from JWT, with DEV_MODE fallback."""
    user_id = extract_user_id(event)
    if user_id:
        return user_id
    if os.environ.get('DEV_MODE', '').lower() == 'true':
        return 'test-user-development'
    return None


def _report_telemetry(user_id: str, operation: str, count: int = 1):
    """Fire-and-forget usage telemetry. Never blocks the response."""
    if not _quota_service or not user_id:
        return
    try:
        ensure_tier_exists(table, user_id)
        _quota_service.report_usage(user_id, operation, count=count)
    except Exception as e:
        logger.debug(f'Telemetry report failed for {operation}: {e}')


def _check_feature_gate(user_id: str, feature_key: str, event) -> dict | None:
    """Return a 403 response if the feature is gated, or None if access is allowed."""
    if _feature_flag_service:
        try:
            flags = _feature_flag_service.get_feature_flags(user_id)
            if not flags.get('features', {}).get(feature_key, False):
                return api_response(
                    403, {'error': 'Feature not available on current plan', 'code': 'FEATURE_GATED'}, event
                )
        except Exception:
            logger.error(f'Feature flag check failed for {feature_key}, denying request')
            return api_response(503, {'error': 'Feature availability check failed'}, event)
    return None


def _gated_handler(feature_key, handler_fn):
    """Wrap a handler with feature gate check. Returns a handler that checks the gate first."""

    def wrapper(body, user_id, event, edge_cache):
        gate = _check_feature_gate(user_id, feature_key, event)
        if gate:
            return gate
        return handler_fn(body, user_id, event, edge_cache)

    return wrapper


def _get_user_edges_cached(user_id, cache):
    # Per-invocation cache only — not shared across warm container reuses
    """Return cached edges or query and cache them. Cache is per-invocation."""
    if user_id not in cache:
        cache[user_id] = _edge_data_service.query_all_edges(user_id)
    return cache[user_id]


# ---------------------------------------------------------------------------
# Operation handlers
# ---------------------------------------------------------------------------


def _handle_get_connections_by_status(body, user_id, event, edge_cache):
    updates = body.get('updates', {})
    r = _edge_data_service.get_connections_by_status(user_id, updates.get('status'))
    return api_response(200, {'connections': r.get('connections', []), 'count': r.get('count', 0)}, event)


def _handle_upsert_status(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    updates = body.get('updates', {})
    return api_response(
        200,
        {
            'result': _edge_data_service.upsert_status(
                user_id, pid, updates.get('status', 'pending'), updates.get('addedAt'), updates.get('messages')
            )
        },
        event,
    )


def _handle_add_message(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    updates = body.get('updates', {})
    return api_response(
        200,
        {
            'result': _edge_data_service.add_message(
                user_id, pid, updates.get('message', ''), updates.get('messageType', 'outbound')
            )
        },
        event,
    )


def _handle_update_messages(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    updates = body.get('updates', {})
    msgs = updates.get('messages', [])
    r = _edge_data_service.update_messages(user_id, pid, msgs)
    return api_response(200, {'result': r}, event)


def _handle_get_messages(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    r = _edge_data_service.get_messages(user_id, pid)
    return api_response(200, {'messages': r.get('messages', []), 'count': r.get('count', 0)}, event)


def _handle_check_exists(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    return api_response(200, _edge_data_service.check_exists(user_id, pid), event)


def _handle_get_messaging_insights(body, user_id, event, edge_cache):
    force = body.get('forceRecompute', False)
    result = _insight_cache_service.get_messaging_insights(
        user_id,
        edge_query_fn=lambda uid: _get_user_edges_cached(uid, edge_cache),
        force_recompute=force,
    )
    return api_response(200, result, event)


def _handle_store_message_insights(body, user_id, event, edge_cache):
    insights = body.get('insights', [])
    if not insights or not isinstance(insights, list):
        return api_response(400, {'error': 'insights list required'}, event)
    result = _insight_cache_service.store_message_insights(user_id, insights)
    return api_response(200, result, event)


def _handle_compute_relationship_scores(body, user_id, event, edge_cache):
    result = _insight_cache_service.compute_and_store_scores(
        user_id,
        edge_query_fn=lambda uid: _get_user_edges_cached(uid, edge_cache),
        scoring_service=_scoring_service,
        profile_metadata_fn=_edge_data_service.get_profile_metadata,
    )
    _report_telemetry(user_id, 'compute_relationship_scores')
    return api_response(200, result, event)


def _handle_get_priority_recommendations(body, user_id, event, edge_cache):
    limit = body.get('limit', 20)
    try:
        limit = int(limit)
    except (ValueError, TypeError):
        limit = 20
    force = body.get('forceRecompute', False)
    result = _insight_cache_service.get_priority_recommendations(
        user_id,
        edge_query_fn=lambda uid: _get_user_edges_cached(uid, edge_cache),
        reply_prob_service=_reply_probability_service,
        priority_service=_priority_inference_service,
        limit=limit,
        force_recompute=force,
    )
    return api_response(200, result, event)


def _handle_get_analytics_dashboard(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_dashboard_summary(user_id, days)
    _report_telemetry(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_connection_funnel(body, user_id, event, edge_cache):
    result = _analytics_service.get_connection_funnel(user_id)
    _report_telemetry(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_growth_timeline(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_growth_timeline(user_id, days)
    _report_telemetry(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_engagement_metrics(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_engagement_metrics(user_id, days)
    _report_telemetry(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_usage_summary(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_usage_summary(user_id, days)
    _report_telemetry(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_send_time_recommendations(body, user_id, event, edge_cache):
    edges = _get_user_edges_cached(user_id, edge_cache)
    result = _send_time_service.compute_send_time_recommendations(edges)
    return api_response(200, result, event)


def _handle_get_reply_probabilities(body, user_id, event, edge_cache):
    edges = _get_user_edges_cached(user_id, edge_cache)
    profile_id = body.get('profileId')
    if profile_id:
        edge = next((e for e in edges if e.get('SK', '').endswith(profile_id)), None)
        if not edge:
            return api_response(404, {'error': 'Connection not found'}, event)
        result = _reply_probability_service.compute_single_probability(edge)
    else:
        result = _reply_probability_service.compute_reply_probabilities(edges)
    return api_response(200, result, event)


def _handle_get_connection_clusters(body, user_id, event, edge_cache):
    edges = _get_user_edges_cached(user_id, edge_cache)
    min_size = body.get('minClusterSize', 2)
    try:
        min_size = int(min_size)
    except (ValueError, TypeError):
        min_size = 2
    result = _cluster_detection_service.detect_clusters(edges, min_cluster_size=min_size)
    return api_response(200, result, event)


def _handle_get_warm_intro_paths(body, user_id, event, edge_cache):
    target_profile_id = body.get('targetProfileId')
    if not target_profile_id:
        return api_response(400, {'error': 'targetProfileId required'}, event)
    result = _warm_intro_paths_service.find_paths(user_id, target_profile_id)
    _report_telemetry(user_id, 'warm_intro_paths')
    return api_response(200, result, event)


# ---------------------------------------------------------------------------
# Routing table: operation name -> handler function
# Gated operations are wrapped with _gated_handler.
# ---------------------------------------------------------------------------

HANDLERS = {
    # Edge CRUD
    'get_connections_by_status': _handle_get_connections_by_status,
    'upsert_status': _handle_upsert_status,
    'add_message': _handle_add_message,
    'update_messages': _handle_update_messages,
    'get_messages': _handle_get_messages,
    'check_exists': _handle_check_exists,
    # Insight operations (some gated)
    'get_messaging_insights': _gated_handler('message_intelligence', _handle_get_messaging_insights),
    'store_message_insights': _handle_store_message_insights,  # Intentionally ungated: passive write allowed for all tiers
    'compute_relationship_scores': _gated_handler('relationship_strength_scoring', _handle_compute_relationship_scores),
    'get_priority_recommendations': _gated_handler('priority_inference', _handle_get_priority_recommendations),
    # Analytics (all gated)
    'get_analytics_dashboard': _gated_handler('advanced_analytics', _handle_get_analytics_dashboard),
    'get_connection_funnel': _gated_handler('advanced_analytics', _handle_get_connection_funnel),
    'get_growth_timeline': _gated_handler('advanced_analytics', _handle_get_growth_timeline),
    'get_engagement_metrics': _gated_handler('advanced_analytics', _handle_get_engagement_metrics),
    'get_usage_summary': _gated_handler('advanced_analytics', _handle_get_usage_summary),
    # Stateless compute (all gated)
    'get_send_time_recommendations': _gated_handler('best_time_to_send', _handle_get_send_time_recommendations),
    'get_reply_probabilities': _gated_handler('reply_probability', _handle_get_reply_probabilities),
    'get_connection_clusters': _gated_handler('cluster_detection', _handle_get_connection_clusters),
    'get_warm_intro_paths': _gated_handler('warm_intro_paths', _handle_get_warm_intro_paths),
}


def _handle_ragstack(body, user_id, event=None):
    """Handle /ragstack route - dispatches to RAGStackProxyService."""
    if not _ragstack_proxy_service.is_configured():
        return api_response(503, {'error': 'RAGStack not configured'}, event)

    operation = body.get('operation')

    if operation == 'search':
        query = body.get('query', '')
        if not query:
            return api_response(400, {'error': 'query is required'}, event)
        try:
            max_results = min(int(body.get('maxResults', 100)), 200)
        except (TypeError, ValueError):
            return api_response(400, {'error': 'maxResults must be a number'}, event)
        result = _ragstack_proxy_service.ragstack_search(query, max_results)
        _report_telemetry(user_id, 'ragstack_search')
        return api_response(200, result, event)

    elif operation == 'ingest':
        profile_id = body.get('profileId')
        markdown_content = body.get('markdownContent')
        metadata = body.get('metadata') or {}
        if not isinstance(metadata, dict):
            return api_response(400, {'error': 'metadata must be an object'}, event)
        if not profile_id:
            return api_response(400, {'error': 'profileId is required'}, event)
        if not markdown_content:
            return api_response(400, {'error': 'markdownContent is required'}, event)
        result = _ragstack_proxy_service.ragstack_ingest(profile_id, markdown_content, metadata, user_id)
        _report_telemetry(user_id, 'ragstack_ingest')
        return api_response(200, result, event)

    elif operation == 'status':
        document_id = body.get('documentId')
        if not document_id:
            return api_response(400, {'error': 'documentId is required'}, event)
        result = _ragstack_proxy_service.ragstack_status(document_id)
        return api_response(200, result, event)

    else:
        return api_response(400, {'error': f'Unsupported ragstack operation: {operation}'}, event)


def lambda_handler(event, context):
    """Route edge operations to decomposed services."""
    from shared_services.observability import setup_correlation_context

    setup_correlation_context(event, context)

    # Debug logging
    logger.info(f'Event keys: {list(event.keys())}')
    logger.info(
        f'Request context: {json.dumps(_sanitize_request_context(event.get("requestContext", {})), default=str)}'
    )

    # Handle CORS preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return api_response(204, '', event)

    try:
        edge_cache = {}
        body = (
            json.loads(event.get('body', '{}'))
            if isinstance(event.get('body'), str)
            else event.get('body') or event or {}
        )
        user_id = _get_user_id(event)
        logger.info(f'Extracted user_id: {user_id}')
        if not user_id:
            return api_response(401, {'error': 'Unauthorized'}, event)

        # Determine route
        raw_path = event.get('rawPath', '') or event.get('path', '')
        op = body.get('operation')

        if '/ragstack' in raw_path:
            return _handle_ragstack(body, user_id, event)

        # Dispatch via routing table
        handler = HANDLERS.get(op)
        if handler:
            return handler(body, user_id, event, edge_cache)

        return api_response(400, {'error': f'Unsupported operation: {op}'}, event)

    except ValidationError as e:
        return api_response(400, {'error': e.message}, event)
    except NotFoundError as e:
        return api_response(404, {'error': e.message}, event)
    except AuthorizationError as e:
        return api_response(403, {'error': e.message}, event)
    except ExternalServiceError as e:
        return api_response(502, {'error': e.message}, event)
    except ServiceError as e:
        return api_response(500, {'error': e.message}, event)
    except Exception as e:
        logger.error(f'Error: {e}')
        return api_response(500, {'error': 'Internal server error'}, event)
