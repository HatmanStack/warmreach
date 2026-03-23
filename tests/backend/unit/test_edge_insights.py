"""Tests for edge-insights Lambda function."""
import json
from unittest.mock import MagicMock

import pytest

from conftest import load_lambda_module


@pytest.fixture
def edge_insights_module():
    """Load the edge-insights Lambda module within a mock AWS context."""
    from moto import mock_aws
    with mock_aws():
        return load_lambda_module('edge-insights')


@pytest.fixture
def mock_services(edge_insights_module):
    """Replace module-level services with mocks and enable feature gates."""
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {
            'message_intelligence': True,
            'relationship_strength_scoring': True,
            'priority_inference': True,
            'advanced_analytics': True,
            'best_time_to_send': True,
            'reply_probability': True,
            'cluster_detection': True,
            'warm_intro_paths': True,
            'network_graph_visualization': True,
        },
        'quotas': {},
        'rateLimits': {},
    }
    orig_ff = edge_insights_module._feature_flag_service
    edge_insights_module._feature_flag_service = mock_ff
    yield {'feature_flags': mock_ff}
    edge_insights_module._feature_flag_service = orig_ff


def _make_event(operation, body=None, user_id='test-user'):
    payload = {'operation': operation}
    if body:
        payload.update(body)
    return {
        'body': json.dumps(payload),
        'requestContext': {'authorizer': {'claims': {'sub': user_id}}},
    }


class TestEdgeInsightsRouting:
    """Tests for edge-insights operation routing."""

    def test_options_returns_204(self, lambda_context, edge_insights_module):
        event = {'requestContext': {'http': {'method': 'OPTIONS'}}}
        resp = edge_insights_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 204

    def test_unauthorized_returns_401(self, lambda_context, edge_insights_module):
        event = {'body': json.dumps({'operation': 'store_message_insights'})}
        resp = edge_insights_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 401

    def test_unsupported_operation_returns_400(self, lambda_context, edge_insights_module):
        event = _make_event('nonexistent_op')
        resp = edge_insights_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400

    def test_store_message_insights_ungated(self, lambda_context, edge_insights_module):
        """store_message_insights is intentionally ungated."""
        mock_cache = MagicMock()
        mock_cache.store_message_insights.return_value = {'success': True, 'insightsUpdatedAt': '2026-01-01'}
        orig = edge_insights_module._insight_cache_service
        edge_insights_module._insight_cache_service = mock_cache
        try:
            event = _make_event('store_message_insights', {'insights': ['insight1']})
            resp = edge_insights_module.lambda_handler(event, lambda_context)
        finally:
            edge_insights_module._insight_cache_service = orig
        assert resp['statusCode'] == 200

    def test_get_messaging_insights_gated(self, lambda_context, edge_insights_module):
        """get_messaging_insights returns 403 when feature is disabled."""
        mock_ff = MagicMock()
        mock_ff.get_feature_flags.return_value = {
            'tier': 'free',
            'features': {'message_intelligence': False},
            'quotas': {},
            'rateLimits': {},
        }
        orig = edge_insights_module._feature_flag_service
        edge_insights_module._feature_flag_service = mock_ff
        try:
            event = _make_event('get_messaging_insights')
            resp = edge_insights_module.lambda_handler(event, lambda_context)
        finally:
            edge_insights_module._feature_flag_service = orig
        assert resp['statusCode'] == 403

    def test_get_analytics_dashboard(self, lambda_context, edge_insights_module, mock_services):
        mock_analytics = MagicMock()
        mock_analytics.get_dashboard_summary.return_value = {'summary': {}}
        orig = edge_insights_module._analytics_service
        edge_insights_module._analytics_service = mock_analytics
        try:
            event = _make_event('get_analytics_dashboard', {'days': 30})
            resp = edge_insights_module.lambda_handler(event, lambda_context)
        finally:
            edge_insights_module._analytics_service = orig
        assert resp['statusCode'] == 200

    def test_get_send_time_recommendations(self, lambda_context, edge_insights_module, mock_services):
        mock_send = MagicMock()
        mock_send.compute_send_time_recommendations.return_value = {'recommendations': []}
        mock_edge = MagicMock()
        mock_edge.query_all_edges.return_value = []
        orig_send = edge_insights_module._send_time_service
        orig_edge = edge_insights_module._edge_data_service
        edge_insights_module._send_time_service = mock_send
        edge_insights_module._edge_data_service = mock_edge
        try:
            event = _make_event('get_send_time_recommendations')
            resp = edge_insights_module.lambda_handler(event, lambda_context)
        finally:
            edge_insights_module._send_time_service = orig_send
            edge_insights_module._edge_data_service = orig_edge
        assert resp['statusCode'] == 200


class TestHandlerCount:
    """Verify the routing table has the expected number of handlers."""

    def test_has_14_handlers(self, edge_insights_module):
        assert len(edge_insights_module.HANDLERS) == 14
