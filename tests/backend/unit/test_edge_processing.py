"""Tests for Edge Processing Lambda"""
import json
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def edge_processing_module():
    """Load the edge-processing Lambda module"""
    return load_lambda_module('edge-processing')


@pytest.fixture
def mock_edge_services(edge_processing_module):
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
        },
        'quotas': {},
        'rateLimits': {},
    }

    orig_quota = edge_processing_module._quota_service
    orig_ff = edge_processing_module._feature_flag_service
    edge_processing_module._quota_service = mock_quota
    edge_processing_module._feature_flag_service = mock_ff
    yield {'quota': mock_quota, 'feature_flags': mock_ff}
    edge_processing_module._quota_service = orig_quota
    edge_processing_module._feature_flag_service = orig_ff


def test_lambda_handler_unauthorized(lambda_context, edge_processing_module):
    """Test that unauthenticated requests return 401"""
    event = {
        'body': json.dumps({'data': 'test'}),
    }

    response = edge_processing_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 401


def test_lambda_handler_with_auth(lambda_context, edge_processing_module):
    """Test authenticated request handling"""
    event = {
        'body': json.dumps({
            'profileId': 'test-profile-123',
            'operation': 'check_exists',
        }),
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'test-user-123',
                }
            }
        }
    }

    response = edge_processing_module.lambda_handler(event, lambda_context)

    # EdgeService wraps ClientError as ExternalServiceError -> handler returns 502
    assert response['statusCode'] == 502
    body = json.loads(response['body'])
    assert 'error' in body


def test_lambda_handler_invalid_input(lambda_context, edge_processing_module):
    """Test handling of invalid input (still requires auth)"""
    event = {
        'body': 'invalid-json{',
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'test-user-123',
                }
            }
        }
    }

    response = edge_processing_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 500
    body = json.loads(response['body'])
    assert 'error' in body


# ---- Messaging insights tests ----


def test_get_messaging_insights_computes_stats(lambda_context, edge_processing_module, mock_edge_services):
    """get_messaging_insights returns computed stats from InsightCacheService."""
    event = {
        'body': json.dumps({'operation': 'get_messaging_insights'}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_result = {
        'stats': {'totalOutbound': 10, 'responseRate': 0.5},
        'insights': None,
        'computedAt': '2026-01-01T00:00:00',
    }
    mock_svc = MagicMock()
    mock_svc.get_messaging_insights.return_value = mock_result
    orig = edge_processing_module._insight_cache_service
    edge_processing_module._insight_cache_service = mock_svc
    try:
        response = edge_processing_module.lambda_handler(event, lambda_context)
    finally:
        edge_processing_module._insight_cache_service = orig
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['stats']['totalOutbound'] == 10
    assert body['insights'] is None


def test_get_messaging_insights_feature_gated(lambda_context, edge_processing_module, mock_edge_services):
    """get_messaging_insights returns 403 when message_intelligence is disabled."""
    mock_edge_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'message_intelligence': False},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({'operation': 'get_messaging_insights'}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 403
    body = json.loads(response['body'])
    assert body['code'] == 'FEATURE_GATED'


def test_get_messaging_insights_force_recompute(lambda_context, edge_processing_module, mock_edge_services):
    """forceRecompute flag is passed to InsightCacheService."""
    event = {
        'body': json.dumps({'operation': 'get_messaging_insights', 'forceRecompute': True}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_svc = MagicMock()
    mock_svc.get_messaging_insights.return_value = {
        'stats': {}, 'insights': None, 'computedAt': '2026-01-01',
    }
    orig = edge_processing_module._insight_cache_service
    edge_processing_module._insight_cache_service = mock_svc
    try:
        response = edge_processing_module.lambda_handler(event, lambda_context)
    finally:
        edge_processing_module._insight_cache_service = orig
    assert response['statusCode'] == 200
    # The handler now calls with edge_query_fn kwarg too
    mock_svc.get_messaging_insights.assert_called_once()
    call_kwargs = mock_svc.get_messaging_insights.call_args
    assert call_kwargs[0][0] == 'test-user'
    assert call_kwargs[1]['force_recompute'] is True


def test_store_message_insights_success(lambda_context, edge_processing_module, mock_edge_services):
    """store_message_insights persists insights successfully."""
    event = {
        'body': json.dumps({
            'operation': 'store_message_insights',
            'insights': ['Insight 1', 'Insight 2'],
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_svc = MagicMock()
    mock_svc.store_message_insights.return_value = {
        'success': True, 'insightsUpdatedAt': '2026-01-01',
    }
    orig = edge_processing_module._insight_cache_service
    edge_processing_module._insight_cache_service = mock_svc
    try:
        response = edge_processing_module.lambda_handler(event, lambda_context)
    finally:
        edge_processing_module._insight_cache_service = orig
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['success'] is True


def test_store_message_insights_missing_list(lambda_context, edge_processing_module, mock_edge_services):
    """store_message_insights returns 400 when insights is not a list."""
    event = {
        'body': json.dumps({
            'operation': 'store_message_insights',
            'insights': 'not a list',
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'insights list required' in body['error']


# ---- Analytics operations tests ----


def test_get_analytics_dashboard_returns_all_sections(lambda_context, edge_processing_module, mock_edge_services):
    """get_analytics_dashboard returns funnel, growth, engagement, usage sections."""
    event = {
        'body': json.dumps({'operation': 'get_analytics_dashboard'}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_result = {
        'funnel': {'total': 5},
        'growth': {'totalGrowth': 2},
        'engagement': {'totals': {'outbound': 3}},
        'usage': {'totalOperations': 10},
        'generatedAt': '2026-01-01T00:00:00',
    }
    with patch.object(edge_processing_module, '_analytics_service') as mock_analytics:
        mock_analytics.get_dashboard_summary.return_value = mock_result
        response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert 'funnel' in body
    assert 'growth' in body
    assert 'engagement' in body
    assert 'usage' in body


def test_analytics_feature_gated(lambda_context, edge_processing_module, mock_edge_services):
    """Analytics operations return 403 when advanced_analytics is disabled."""
    mock_edge_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'advanced_analytics': False},
        'quotas': {},
        'rateLimits': {},
    }
    for op in ['get_analytics_dashboard', 'get_connection_funnel', 'get_growth_timeline',
               'get_engagement_metrics', 'get_usage_summary']:
        event = {
            'body': json.dumps({'operation': op}),
            'requestContext': {
                'authorizer': {'claims': {'sub': 'test-user'}}
            },
        }
        response = edge_processing_module.lambda_handler(event, lambda_context)
        assert response['statusCode'] == 403, f'{op} should be feature-gated'
        body = json.loads(response['body'])
        assert body['code'] == 'FEATURE_GATED'


def test_get_growth_timeline_days_param(lambda_context, edge_processing_module, mock_edge_services):
    """get_growth_timeline passes days parameter."""
    event = {
        'body': json.dumps({'operation': 'get_growth_timeline', 'days': 7}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    with patch.object(edge_processing_module, '_analytics_service') as mock_analytics:
        mock_analytics.get_growth_timeline.return_value = {'timeline': [], 'period': 7, 'totalGrowth': 0, 'avgDailyGrowth': 0}
        response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    mock_analytics.get_growth_timeline.assert_called_once_with('test-user', 7)


def test_feature_gate_exception_returns_503(lambda_context, edge_processing_module, mock_edge_services):
    """When get_feature_flags raises, _check_feature_gate returns 503 (fail-closed)."""
    mock_edge_services['feature_flags'].get_feature_flags.side_effect = RuntimeError('DDB timeout')
    event = {
        'body': json.dumps({'operation': 'get_messaging_insights'}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 503
    body = json.loads(response['body'])
    assert 'Feature availability check failed' in body['error']


def test_feature_gate_enabled_returns_none(edge_processing_module, mock_edge_services):
    """When feature is enabled, _check_feature_gate returns None (allow)."""
    mock_edge_services['feature_flags'].get_feature_flags.return_value = {
        'features': {'message_intelligence': True},
    }
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = edge_processing_module._check_feature_gate('test-user', 'message_intelligence', event)
    assert result is None


def test_feature_gate_disabled_returns_403(edge_processing_module, mock_edge_services):
    """When feature is disabled, _check_feature_gate returns 403."""
    mock_edge_services['feature_flags'].get_feature_flags.return_value = {
        'features': {'message_intelligence': False},
    }
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = edge_processing_module._check_feature_gate('test-user', 'message_intelligence', event)
    assert result is not None
    assert result['statusCode'] == 403


def test_edge_cache_deduplicates_queries(edge_processing_module):
    """_get_user_edges_cached calls _query_all_user_edges once per user_id."""
    mock_edges = [{'PK': 'USER#u1', 'SK': 'EDGE#p1', 'status': 'connected'}]
    mock_svc = MagicMock()
    mock_svc.query_all_edges.return_value = mock_edges

    orig = edge_processing_module._edge_data_service
    edge_processing_module._edge_data_service = mock_svc
    try:
        cache = {}
        result1 = edge_processing_module._get_user_edges_cached('u1', cache)
        result2 = edge_processing_module._get_user_edges_cached('u1', cache)
        assert result1 == mock_edges
        assert result2 == mock_edges
        mock_svc.query_all_edges.assert_called_once_with('u1')
    finally:
        edge_processing_module._edge_data_service = orig


def test_edge_cache_separate_users(edge_processing_module):
    """_get_user_edges_cached caches per user_id independently."""
    mock_svc = MagicMock()
    mock_svc.query_all_edges.side_effect = lambda uid: [{'user': uid}]

    orig = edge_processing_module._edge_data_service
    edge_processing_module._edge_data_service = mock_svc
    try:
        cache = {}
        r1 = edge_processing_module._get_user_edges_cached('u1', cache)
        r2 = edge_processing_module._get_user_edges_cached('u2', cache)
        assert r1 == [{'user': 'u1'}]
        assert r2 == [{'user': 'u2'}]
        assert mock_svc.query_all_edges.call_count == 2
    finally:
        edge_processing_module._edge_data_service = orig


def test_analytics_days_capped_at_365(lambda_context, edge_processing_module, mock_edge_services):
    """days parameter is capped at 365."""
    event = {
        'body': json.dumps({'operation': 'get_growth_timeline', 'days': 9999}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    with patch.object(edge_processing_module, '_analytics_service') as mock_analytics:
        mock_analytics.get_growth_timeline.return_value = {'timeline': [], 'period': 365, 'totalGrowth': 0, 'avgDailyGrowth': 0}
        response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    mock_analytics.get_growth_timeline.assert_called_once_with('test-user', 365)
