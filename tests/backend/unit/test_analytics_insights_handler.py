"""Tests for analytics-insights Lambda handler."""

import json
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def analytics_module():
    """Load the analytics-insights Lambda module."""
    return load_lambda_module('analytics-insights')


@pytest.fixture
def mock_analytics_services(analytics_module):
    """Replace module-level quota and feature flag services with mocks."""
    mock_quota = MagicMock()
    mock_quota.report_usage.return_value = None
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {
            'message_intelligence': True,
            'relationship_strength_scoring': True,
            'advanced_analytics': True,
            'influence_mapping': True,
            'opportunity_tracker': True,
            'network_gap_analysis': True,
            'priority_inference': True,
            'best_time_to_send': True,
            'reply_probability': True,
            'cluster_detection': True,
            'warm_intro_paths': True,
            'network_graph_visualization': True,
        },
        'quotas': {},
        'rateLimits': {},
    }

    orig_quota = analytics_module._quota_service
    orig_ff = analytics_module._feature_flag_service
    analytics_module._quota_service = mock_quota
    analytics_module._feature_flag_service = mock_ff
    yield {'quota': mock_quota, 'feature_flags': mock_ff}
    analytics_module._quota_service = orig_quota
    analytics_module._feature_flag_service = orig_ff


def _make_event(operation, **extra):
    body = {'operation': operation}
    body.update(extra)
    return {
        'body': json.dumps(body),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }


def test_handler_has_required_operations(analytics_module):
    """HANDLERS dict contains all required analytics/insights operations."""
    required = {
        'get_messaging_insights', 'store_message_insights', 'compute_relationship_scores',
        'get_priority_recommendations', 'get_analytics_dashboard', 'get_connection_funnel',
        'get_growth_timeline', 'get_engagement_metrics', 'get_usage_summary',
        'get_send_time_recommendations', 'get_reply_probabilities', 'get_connection_clusters',
        'get_warm_intro_paths', 'get_network_graph', 'create_opportunity', 'update_opportunity',
        'archive_opportunity', 'complete_opportunity', 'delete_opportunity',
        'list_opportunities', 'get_opportunity', 'get_influence_scores', 'analyze_gaps',
    }
    assert required.issubset(set(analytics_module.HANDLERS.keys()))


def test_get_analytics_dashboard_gated(lambda_context, analytics_module, mock_analytics_services):
    """get_analytics_dashboard returns 403 when gated."""
    mock_analytics_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'advanced_analytics': False},
        'quotas': {},
        'rateLimits': {},
    }
    event = _make_event('get_analytics_dashboard')
    response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 403


def test_get_analytics_dashboard_success(lambda_context, analytics_module, mock_analytics_services):
    """get_analytics_dashboard returns 200 with dashboard data."""
    event = _make_event('get_analytics_dashboard', days=30)
    mock_result = {
        'funnel': {'total': 5},
        'growth': {'totalGrowth': 2},
        'engagement': {'totals': {'outbound': 3}},
        'usage': {'totalOperations': 10},
        'generatedAt': '2026-01-01T00:00:00',
    }
    with patch.object(analytics_module, '_analytics_service') as mock_svc:
        mock_svc.get_dashboard_summary.return_value = mock_result
        response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert 'funnel' in body


def test_compute_relationship_scores(lambda_context, analytics_module, mock_analytics_services):
    """compute_relationship_scores returns 200."""
    event = _make_event('compute_relationship_scores')
    mock_cache_svc = MagicMock()
    mock_cache_svc.compute_and_store_scores.return_value = {'scores': [], 'count': 0}
    orig = analytics_module._insight_cache_service
    analytics_module._insight_cache_service = mock_cache_svc
    try:
        response = analytics_module.lambda_handler(event, lambda_context)
    finally:
        analytics_module._insight_cache_service = orig
    assert response['statusCode'] == 200


def test_get_connection_clusters(lambda_context, analytics_module, mock_analytics_services):
    """get_connection_clusters returns 200."""
    event = _make_event('get_connection_clusters')
    mock_edge_svc = MagicMock()
    mock_edge_svc.query_all_edges.return_value = []
    mock_cluster_svc = MagicMock()
    mock_cluster_svc.detect_clusters.return_value = {'clusters': []}
    orig_edge = analytics_module._edge_data_service
    orig_cluster = analytics_module._cluster_detection_service
    analytics_module._edge_data_service = mock_edge_svc
    analytics_module._cluster_detection_service = mock_cluster_svc
    try:
        response = analytics_module.lambda_handler(event, lambda_context)
    finally:
        analytics_module._edge_data_service = orig_edge
        analytics_module._cluster_detection_service = orig_cluster
    assert response['statusCode'] == 200


def test_create_opportunity_requires_name(lambda_context, analytics_module, mock_analytics_services):
    """create_opportunity without name returns 400."""
    event = _make_event('create_opportunity')
    response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400


def test_create_opportunity_success(lambda_context, analytics_module, mock_analytics_services):
    """create_opportunity returns 200."""
    event = _make_event('create_opportunity', name='Test Opp', targetCompanies=['Acme'])
    mock_opp_svc = MagicMock()
    mock_opp_svc.create_opportunity.return_value = {
        'success': True, 'opportunityId': 'opp-1', 'name': 'Test Opp',
    }
    orig = analytics_module._opportunity_service
    analytics_module._opportunity_service = mock_opp_svc
    try:
        with patch.object(analytics_module, 'write_activity'):
            response = analytics_module.lambda_handler(event, lambda_context)
    finally:
        analytics_module._opportunity_service = orig
    assert response['statusCode'] == 200


def test_get_influence_scores_gated(lambda_context, analytics_module, mock_analytics_services):
    """get_influence_scores returns 403 when influence_mapping is disabled."""
    mock_analytics_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'influence_mapping': False},
        'quotas': {},
        'rateLimits': {},
    }
    event = _make_event('get_influence_scores')
    response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 403


def test_get_influence_scores_success(lambda_context, analytics_module, mock_analytics_services):
    """get_influence_scores returns 200."""
    event = _make_event('get_influence_scores')
    mock_edge_svc = MagicMock()
    mock_edge_svc.query_all_edges.return_value = []
    mock_cluster_svc = MagicMock()
    mock_cluster_svc.detect_clusters.return_value = {'clusters': []}
    mock_influence_svc = MagicMock()
    mock_influence_svc.compute_influence_scores.return_value = {'influencers': []}
    orig_edge = analytics_module._edge_data_service
    orig_cluster = analytics_module._cluster_detection_service
    orig_influence = analytics_module._influence_mapping_service
    analytics_module._edge_data_service = mock_edge_svc
    analytics_module._cluster_detection_service = mock_cluster_svc
    analytics_module._influence_mapping_service = mock_influence_svc
    try:
        response = analytics_module.lambda_handler(event, lambda_context)
    finally:
        analytics_module._edge_data_service = orig_edge
        analytics_module._cluster_detection_service = orig_cluster
        analytics_module._influence_mapping_service = orig_influence
    assert response['statusCode'] == 200


def test_analyze_gaps_requires_opportunity_id(lambda_context, analytics_module, mock_analytics_services):
    """analyze_gaps without opportunityId returns 400."""
    event = _make_event('analyze_gaps')
    response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400


def test_analyze_gaps_success(lambda_context, analytics_module, mock_analytics_services):
    """analyze_gaps returns 200."""
    event = _make_event('analyze_gaps', opportunityId='opp-1')
    mock_opp_svc = MagicMock()
    mock_opp_svc.get_opportunity.return_value = {
        'success': True,
        'opportunity': {
            'SK': 'OPPORTUNITY#opp-1', 'name': 'Test',
            'targetCompanies': [], 'targetRoles': [], 'targetIndustries': [],
        },
    }
    mock_edge_svc = MagicMock()
    mock_edge_svc.query_all_edges.return_value = []
    mock_cluster_svc = MagicMock()
    mock_cluster_svc.detect_clusters.return_value = {'clusters': []}
    mock_gap_svc = MagicMock()
    mock_gap_svc.analyze_gaps.return_value = {
        'opportunity': {'id': 'opp-1'}, 'analysis': {}, 'coverageScore': 1.0,
    }
    orig_opp = analytics_module._opportunity_service
    orig_edge = analytics_module._edge_data_service
    orig_cluster = analytics_module._cluster_detection_service
    orig_gap = analytics_module._gap_analysis_service
    analytics_module._opportunity_service = mock_opp_svc
    analytics_module._edge_data_service = mock_edge_svc
    analytics_module._cluster_detection_service = mock_cluster_svc
    analytics_module._gap_analysis_service = mock_gap_svc
    try:
        response = analytics_module.lambda_handler(event, lambda_context)
    finally:
        analytics_module._opportunity_service = orig_opp
        analytics_module._edge_data_service = orig_edge
        analytics_module._cluster_detection_service = orig_cluster
        analytics_module._gap_analysis_service = orig_gap
    assert response['statusCode'] == 200


def test_options_returns_204(lambda_context, analytics_module):
    """OPTIONS returns 204."""
    event = {'requestContext': {'http': {'method': 'OPTIONS'}}}
    response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 204


def test_unauthorized_returns_401(lambda_context, analytics_module):
    """Unauthenticated requests return 401."""
    event = {'body': json.dumps({'operation': 'get_analytics_dashboard'})}
    response = analytics_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 401
