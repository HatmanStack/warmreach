"""Edge Insights Lambda - Routes insights, analytics, and stateless compute operations."""

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
from shared_services.observability import setup_correlation_context
from shared_services.priority_inference_service import PriorityInferenceService
from shared_services.relationship_scoring_service import RelationshipScoringService
from shared_services.reply_probability_service import ReplyProbabilityService
from shared_services.request_utils import api_response, extract_user_id
from shared_services.send_time_service import SendTimeService
from shared_services.warm_intro_paths_service import WarmIntroPathsService

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration and clients
_table_name = os.environ.get('DYNAMODB_TABLE_NAME')
if not _table_name:
    raise RuntimeError('FATAL: DYNAMODB_TABLE_NAME environment variable is required')
table = boto3.resource('dynamodb').Table(_table_name)

# Module-level clients for warm container reuse
_quota_service = QuotaService(table) if table else None
_feature_flag_service = FeatureFlagService(table) if table else None
_analytics_service = AnalyticsService(table) if table else None
_priority_inference_service = PriorityInferenceService()
_reply_probability_service = ReplyProbabilityService()
_cluster_detection_service = ClusterDetectionService()
_send_time_service = SendTimeService()
_scoring_service = RelationshipScoringService()
_warm_intro_paths_service = WarmIntroPathsService(table)
_edge_data_service = EdgeDataService(table=table)
_insight_cache_service = InsightCacheService(table=table)


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
        logger.warning(f'Telemetry report failed for {operation}: {e}')


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
    """Wrap a handler with feature gate check."""

    def wrapper(body, user_id, event, edge_cache):
        gate = _check_feature_gate(user_id, feature_key, event)
        if gate:
            return gate
        return handler_fn(body, user_id, event, edge_cache)

    return wrapper


def _get_user_edges_cached(user_id, cache):
    """Return cached edges or query and cache them. Cache is per-invocation."""
    if user_id not in cache:
        cache[user_id] = _edge_data_service.query_all_edges(user_id)
    return cache[user_id]


# ---------------------------------------------------------------------------
# Operation handlers
# ---------------------------------------------------------------------------


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


def _handle_get_network_graph(body, user_id, event, edge_cache):
    edges = _get_user_edges_cached(user_id, edge_cache)
    profile_ids = [edge_item.get('SK', '').replace('PROFILE#', '') for edge_item in edges]
    metadata_map = _edge_data_service.batch_get_profile_metadata(profile_ids)

    nodes = []
    for edge_item in edges:
        profile_id = edge_item.get('SK', '').replace('PROFILE#', '')
        profile_data = metadata_map.get(profile_id, {})
        name = profile_data.get('name', '')
        name_parts = name.split(' ', 1)
        first_name = name_parts[0] if name_parts else ''
        last_name = name_parts[1] if len(name_parts) > 1 else ''

        nodes.append(
            {
                'id': profile_id,
                'firstName': first_name,
                'lastName': last_name,
                'position': profile_data.get('currentTitle', ''),
                'company': profile_data.get('currentCompany', ''),
                'location': profile_data.get('currentLocation', ''),
                'headline': profile_data.get('headline', ''),
                'profilePictureUrl': profile_data.get('profilePictureUrl', ''),
                'relationshipScore': edge_item.get('relationshipScore'),
                'status': edge_item.get('status', ''),
            }
        )

    edge_list = [
        {
            'source': 'user',
            'target': edge_item.get('SK', '').replace('PROFILE#', ''),
            'relationshipScore': edge_item.get('relationshipScore'),
            'status': edge_item.get('status', ''),
        }
        for edge_item in edges
    ]

    clusters_result = _cluster_detection_service.detect_clusters(edges)
    _report_telemetry(user_id, 'network_graph_query')

    return api_response(
        200,
        {
            'nodes': nodes,
            'edges': edge_list,
            'clusters': clusters_result.get('clusters', []),
            'totalConnections': len(edges),
        },
        event,
    )


# ---------------------------------------------------------------------------
# Routing table: 14 operations
# ---------------------------------------------------------------------------

HANDLERS = {
    'get_messaging_insights': _gated_handler('message_intelligence', _handle_get_messaging_insights),
    'store_message_insights': _handle_store_message_insights,
    'compute_relationship_scores': _gated_handler('relationship_strength_scoring', _handle_compute_relationship_scores),
    'get_priority_recommendations': _gated_handler('priority_inference', _handle_get_priority_recommendations),
    'get_analytics_dashboard': _gated_handler('advanced_analytics', _handle_get_analytics_dashboard),
    'get_connection_funnel': _gated_handler('advanced_analytics', _handle_get_connection_funnel),
    'get_growth_timeline': _gated_handler('advanced_analytics', _handle_get_growth_timeline),
    'get_engagement_metrics': _gated_handler('advanced_analytics', _handle_get_engagement_metrics),
    'get_usage_summary': _gated_handler('advanced_analytics', _handle_get_usage_summary),
    'get_send_time_recommendations': _gated_handler('best_time_to_send', _handle_get_send_time_recommendations),
    'get_reply_probabilities': _gated_handler('reply_probability', _handle_get_reply_probabilities),
    'get_connection_clusters': _gated_handler('cluster_detection', _handle_get_connection_clusters),
    'get_warm_intro_paths': _gated_handler('warm_intro_paths', _handle_get_warm_intro_paths),
    'get_network_graph': _gated_handler('network_graph_visualization', _handle_get_network_graph),
}


def lambda_handler(event, context):
    """Route edge insights operations."""
    setup_correlation_context(event, context)

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
        if not user_id:
            return api_response(401, {'error': 'Unauthorized'}, event)

        op = body.get('operation')
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
