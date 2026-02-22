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

    # EdgeService wraps ClientError as ExternalServiceError → handler returns 502
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
    """get_messaging_insights returns computed stats from EdgeService."""
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
    with patch.object(edge_processing_module, 'EdgeService') as MockSvc:
        MockSvc.return_value.get_messaging_insights.return_value = mock_result
        response = edge_processing_module.lambda_handler(event, lambda_context)
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
    """forceRecompute flag is passed to EdgeService."""
    event = {
        'body': json.dumps({'operation': 'get_messaging_insights', 'forceRecompute': True}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    with patch.object(edge_processing_module, 'EdgeService') as MockSvc:
        MockSvc.return_value.get_messaging_insights.return_value = {
            'stats': {}, 'insights': None, 'computedAt': '2026-01-01',
        }
        response = edge_processing_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    MockSvc.return_value.get_messaging_insights.assert_called_once_with('test-user', force_recompute=True)


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
    with patch.object(edge_processing_module, 'EdgeService') as MockSvc:
        MockSvc.return_value.store_message_insights.return_value = {
            'success': True, 'insightsUpdatedAt': '2026-01-01',
        }
        response = edge_processing_module.lambda_handler(event, lambda_context)
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
