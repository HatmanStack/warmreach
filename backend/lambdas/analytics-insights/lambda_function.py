"""Analytics & Insights Lambda - Scoring, clustering, analytics, opportunities, gap analysis."""

import json
import logging
import os

import boto3
from errors.exceptions import AuthorizationError, ExternalServiceError, NotFoundError, ServiceError, ValidationError
from shared_services.activity_writer import write_activity
from shared_services.analytics_service import AnalyticsService
from shared_services.cluster_detection_service import ClusterDetectionService
from shared_services.edge_data_service import EdgeDataService
from shared_services.gap_analysis_service import GapAnalysisService
from shared_services.handler_utils import (
    get_user_edges_cached,
    get_user_id,
    lazy_gated_handler,
    report_telemetry,
    sanitize_request_context,
)
from shared_services.influence_mapping_service import InfluenceMappingService
from shared_services.insight_cache_service import InsightCacheService
from shared_services.monetization import FeatureFlagService, QuotaService
from shared_services.observability import setup_correlation_context
from shared_services.opportunity_service import OpportunityService
from shared_services.priority_inference_service import PriorityInferenceService
from shared_services.relationship_scoring_service import RelationshipScoringService
from shared_services.reply_probability_service import ReplyProbabilityService
from shared_services.request_utils import api_response
from shared_services.send_time_service import SendTimeService
from shared_services.warm_intro_paths_service import WarmIntroPathsService

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration and clients
_table_name = os.environ.get('DYNAMODB_TABLE_NAME')
if not _table_name:
    raise RuntimeError('FATAL: DYNAMODB_TABLE_NAME environment variable is required')
table = boto3.resource('dynamodb').Table(_table_name)
RAGSTACK_GRAPHQL_ENDPOINT = os.environ.get('RAGSTACK_GRAPHQL_ENDPOINT', '')
RAGSTACK_API_KEY = os.environ.get('RAGSTACK_API_KEY', '')

# Conditional RAGStack client (needed by EdgeDataService)
_ragstack_client = None
_ingestion_service = None
if RAGSTACK_GRAPHQL_ENDPOINT and RAGSTACK_API_KEY:
    from shared_services.ingestion_service import IngestionService
    from shared_services.ragstack_client import RAGStackClient

    _ragstack_client = RAGStackClient(RAGSTACK_GRAPHQL_ENDPOINT, RAGSTACK_API_KEY)
    _ingestion_service = IngestionService(_ragstack_client)

# Module-level service initialization
_edge_data_service = EdgeDataService(
    table=table,
    ragstack_endpoint=RAGSTACK_GRAPHQL_ENDPOINT,
    ragstack_api_key=RAGSTACK_API_KEY,
    ragstack_client=_ragstack_client,
    ingestion_service=_ingestion_service,
)
_insight_cache_service = InsightCacheService(table=table)
_analytics_service = AnalyticsService(table) if table else None
_scoring_service = RelationshipScoringService()
_reply_probability_service = ReplyProbabilityService()
_priority_inference_service = PriorityInferenceService()
_cluster_detection_service = ClusterDetectionService()
_send_time_service = SendTimeService()
_warm_intro_paths_service = WarmIntroPathsService(table)
_influence_mapping_service = InfluenceMappingService()
_opportunity_service = OpportunityService(table)
_gap_analysis_service = GapAnalysisService(table, _warm_intro_paths_service)
_quota_service = QuotaService(table) if table else None
_feature_flag_service = FeatureFlagService(table) if table else None


def _gated(feature_key, handler_fn):
    """Wrap a handler with feature gate check using module-level _feature_flag_service."""
    return lazy_gated_handler(lambda: _feature_flag_service, feature_key, handler_fn)


def _report(user_id, operation, count=1):
    """Shorthand for report_telemetry with module-level services."""
    report_telemetry(_quota_service, table, user_id, operation, count)


def _get_edges(user_id, edge_cache):
    """Shorthand for get_user_edges_cached with module-level edge service."""
    return get_user_edges_cached(_edge_data_service, user_id, edge_cache)


# ---------------------------------------------------------------------------
# Insight operations
# ---------------------------------------------------------------------------


def _handle_get_messaging_insights(body, user_id, event, edge_cache):
    force = body.get('forceRecompute', False)
    result = _insight_cache_service.get_messaging_insights(
        user_id,
        edge_query_fn=lambda uid: _get_edges(uid, edge_cache),
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
        edge_query_fn=lambda uid: _get_edges(uid, edge_cache),
        scoring_service=_scoring_service,
        profile_metadata_fn=_edge_data_service.get_profile_metadata,
    )
    _report(user_id, 'compute_relationship_scores')
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
        edge_query_fn=lambda uid: _get_edges(uid, edge_cache),
        reply_prob_service=_reply_probability_service,
        priority_service=_priority_inference_service,
        limit=limit,
        force_recompute=force,
    )
    return api_response(200, result, event)


# ---------------------------------------------------------------------------
# Analytics operations
# ---------------------------------------------------------------------------


def _handle_get_analytics_dashboard(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_dashboard_summary(user_id, days)
    _report(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_connection_funnel(body, user_id, event, edge_cache):
    result = _analytics_service.get_connection_funnel(user_id)
    _report(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_growth_timeline(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_growth_timeline(user_id, days)
    _report(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_engagement_metrics(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_engagement_metrics(user_id, days)
    _report(user_id, 'analytics_query')
    return api_response(200, result, event)


def _handle_get_usage_summary(body, user_id, event, edge_cache):
    try:
        days = min(int(body.get('days', 30)), 365)
    except (TypeError, ValueError):
        return api_response(400, {'error': 'days must be a number'}, event)
    result = _analytics_service.get_usage_summary(user_id, days)
    _report(user_id, 'analytics_query')
    return api_response(200, result, event)


# ---------------------------------------------------------------------------
# Stateless compute operations
# ---------------------------------------------------------------------------


def _handle_get_send_time_recommendations(body, user_id, event, edge_cache):
    edges = _get_edges(user_id, edge_cache)
    result = _send_time_service.compute_send_time_recommendations(edges)
    return api_response(200, result, event)


def _handle_get_reply_probabilities(body, user_id, event, edge_cache):
    edges = _get_edges(user_id, edge_cache)
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
    edges = _get_edges(user_id, edge_cache)
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
    _report(user_id, 'warm_intro_paths')
    return api_response(200, result, event)


def _handle_get_network_graph(body, user_id, event, edge_cache):
    edges = _get_edges(user_id, edge_cache)

    # Batch fetch all profile metadata
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

    _report(user_id, 'network_graph_query')

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
# Opportunity operations
# ---------------------------------------------------------------------------


def _handle_create_opportunity(body, user_id, event, edge_cache):
    name = body.get('name')
    if not name:
        return api_response(400, {'error': 'name required'}, event)
    result = _opportunity_service.create_opportunity(
        user_id=user_id,
        name=name,
        description=body.get('description', ''),
        target_companies=body.get('targetCompanies'),
        target_roles=body.get('targetRoles'),
        target_industries=body.get('targetIndustries'),
    )
    write_activity(
        table,
        user_id,
        'opportunity_created',
        metadata={'opportunityId': result.get('opportunityId'), 'name': name},
    )
    return api_response(200, result, event)


def _handle_update_opportunity(body, user_id, event, edge_cache):
    opp_id = body.get('opportunityId')
    if not opp_id:
        return api_response(400, {'error': 'opportunityId required'}, event)
    updates = body.get('updates', {})
    if not isinstance(updates, dict):
        return api_response(400, {'error': 'updates must be an object'}, event)
    for list_field in ('targetCompanies', 'targetRoles', 'targetIndustries'):
        if list_field in updates:
            val = updates[list_field]
            if not isinstance(val, list) or not all(isinstance(item, str) for item in val):
                return api_response(400, {'error': f'{list_field} must be a list of strings'}, event)
    for str_field in ('name', 'status'):
        if str_field in updates and not isinstance(updates[str_field], str):
            return api_response(400, {'error': f'{str_field} must be a string'}, event)
    result = _opportunity_service.update_opportunity(user_id, opp_id, updates)
    return api_response(200, result, event)


def _handle_archive_opportunity(body, user_id, event, edge_cache):
    opp_id = body.get('opportunityId')
    if not opp_id:
        return api_response(400, {'error': 'opportunityId required'}, event)
    result = _opportunity_service.archive_opportunity(user_id, opp_id)
    write_activity(
        table,
        user_id,
        'opportunity_archived',
        metadata={'opportunityId': opp_id, 'name': body.get('name', '')},
    )
    return api_response(200, result, event)


def _handle_complete_opportunity(body, user_id, event, edge_cache):
    opp_id = body.get('opportunityId')
    outcome = body.get('outcome')
    if not opp_id:
        return api_response(400, {'error': 'opportunityId required'}, event)
    if not outcome:
        return api_response(400, {'error': 'outcome required'}, event)
    result = _opportunity_service.complete_opportunity(user_id, opp_id, outcome)
    write_activity(
        table,
        user_id,
        'opportunity_completed',
        metadata={'opportunityId': opp_id, 'name': body.get('name', ''), 'outcome': outcome},
    )
    return api_response(200, result, event)


def _handle_delete_opportunity(body, user_id, event, edge_cache):
    opp_id = body.get('opportunityId')
    if not opp_id:
        return api_response(400, {'error': 'opportunityId required'}, event)
    result = _opportunity_service.delete_opportunity(user_id, opp_id)
    return api_response(200, result, event)


def _handle_list_opportunities(body, user_id, event, edge_cache):
    status_filter = body.get('statusFilter')
    result = _opportunity_service.list_opportunities(user_id, status_filter=status_filter)
    return api_response(200, result, event)


def _handle_get_opportunity(body, user_id, event, edge_cache):
    opp_id = body.get('opportunityId')
    if not opp_id:
        return api_response(400, {'error': 'opportunityId required'}, event)
    result = _opportunity_service.get_opportunity(user_id, opp_id)
    return api_response(200, result, event)


# ---------------------------------------------------------------------------
# Influence/gap analysis operations
# ---------------------------------------------------------------------------


def _handle_get_influence_scores(body, user_id, event, edge_cache):
    edges = _get_edges(user_id, edge_cache)
    clusters = _cluster_detection_service.detect_clusters(edges)
    top_n = body.get('topN', 20)
    try:
        top_n = int(top_n)
    except (ValueError, TypeError):
        top_n = 20
    result = _influence_mapping_service.compute_influence_scores(clusters.get('clusters', []), top_n=top_n)
    return api_response(200, result, event)


def _handle_analyze_gaps(body, user_id, event, edge_cache):
    opp_id = body.get('opportunityId')
    if not opp_id:
        return api_response(400, {'error': 'opportunityId required'}, event)
    opp_result = _opportunity_service.get_opportunity(user_id, opp_id)
    opportunity = opp_result['opportunity']
    edges = _get_edges(user_id, edge_cache)
    clusters = _cluster_detection_service.detect_clusters(edges)
    result = _gap_analysis_service.analyze_gaps(user_id, opportunity, edges, clusters.get('clusters', []))
    return api_response(200, result, event)


# ---------------------------------------------------------------------------
# Routing table
# ---------------------------------------------------------------------------

HANDLERS = {
    'get_messaging_insights': _gated('message_intelligence', _handle_get_messaging_insights),
    'store_message_insights': _handle_store_message_insights,
    'compute_relationship_scores': _gated('relationship_strength_scoring', _handle_compute_relationship_scores),
    'get_priority_recommendations': _gated('priority_inference', _handle_get_priority_recommendations),
    'get_analytics_dashboard': _gated('advanced_analytics', _handle_get_analytics_dashboard),
    'get_connection_funnel': _gated('advanced_analytics', _handle_get_connection_funnel),
    'get_growth_timeline': _gated('advanced_analytics', _handle_get_growth_timeline),
    'get_engagement_metrics': _gated('advanced_analytics', _handle_get_engagement_metrics),
    'get_usage_summary': _gated('advanced_analytics', _handle_get_usage_summary),
    'get_send_time_recommendations': _gated('best_time_to_send', _handle_get_send_time_recommendations),
    'get_reply_probabilities': _gated('reply_probability', _handle_get_reply_probabilities),
    'get_connection_clusters': _gated('cluster_detection', _handle_get_connection_clusters),
    'get_warm_intro_paths': _gated('warm_intro_paths', _handle_get_warm_intro_paths),
    'get_network_graph': _gated('network_graph_visualization', _handle_get_network_graph),
    'create_opportunity': _gated('opportunity_tracker', _handle_create_opportunity),
    'update_opportunity': _gated('opportunity_tracker', _handle_update_opportunity),
    'archive_opportunity': _gated('opportunity_tracker', _handle_archive_opportunity),
    'complete_opportunity': _gated('opportunity_tracker', _handle_complete_opportunity),
    'delete_opportunity': _gated('opportunity_tracker', _handle_delete_opportunity),
    'list_opportunities': _gated('opportunity_tracker', _handle_list_opportunities),
    'get_opportunity': _gated('opportunity_tracker', _handle_get_opportunity),
    'get_influence_scores': _gated('influence_mapping', _handle_get_influence_scores),
    'analyze_gaps': _gated('network_gap_analysis', _handle_analyze_gaps),
}


def lambda_handler(event, context):
    """Route analytics and insight operations."""
    setup_correlation_context(event, context)

    logger.debug(f'Event keys: {list(event.keys())}')
    logger.debug(
        f'Request context: {json.dumps(sanitize_request_context(event.get("requestContext", {})), default=str)}'
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
        user_id = get_user_id(event)
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
