"""Tests for shared handler utilities."""

import os
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def handler_utils():
    """Import handler_utils from shared_services."""
    from shared_services.handler_utils import (
        check_feature_gate,
        get_user_edges_cached,
        get_user_id,
        report_telemetry,
        sanitize_request_context,
    )

    return {
        'sanitize_request_context': sanitize_request_context,
        'get_user_id': get_user_id,
        'report_telemetry': report_telemetry,
        'check_feature_gate': check_feature_gate,
        'get_user_edges_cached': get_user_edges_cached,
    }


def test_sanitize_request_context_redacts_sensitive_keys(handler_utils):
    """Verify authorizer, tokens are redacted."""
    ctx = {
        'authorizer': {'claims': {'sub': 'user-1'}},
        'authorization': 'Bearer xyz',
        'http': {
            'method': 'POST',
            'token': 'secret-token',
            'authorization': 'Bearer abc',
            'path': '/edges',
        },
        'stage': 'prod',
    }
    result = handler_utils['sanitize_request_context'](ctx)
    assert result['authorizer'] == '[REDACTED]'
    assert result['authorization'] == '[REDACTED]'
    assert result['http']['token'] == '[REDACTED]'
    assert result['http']['authorization'] == '[REDACTED]'
    assert result['http']['method'] == 'POST'
    assert result['http']['path'] == '/edges'
    assert result['stage'] == 'prod'


def test_sanitize_request_context_handles_none(handler_utils):
    """Verify None input returns empty dict."""
    result = handler_utils['sanitize_request_context'](None)
    assert result == {}


def test_get_user_id_extracts_from_jwt(handler_utils):
    """Mock event with JWT claims."""
    event = {
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'user-abc-123',
                }
            }
        }
    }
    result = handler_utils['get_user_id'](event)
    assert result == 'user-abc-123'


def test_get_user_id_dev_mode_fallback(handler_utils, monkeypatch):
    """Verify dev mode returns test user."""
    monkeypatch.setenv('DEV_MODE', 'true')
    event = {}  # No auth context
    result = handler_utils['get_user_id'](event)
    assert result == 'test-user-development'


def test_get_user_id_returns_none_without_auth(handler_utils, monkeypatch):
    """No auth and no dev mode returns None."""
    monkeypatch.delenv('DEV_MODE', raising=False)
    event = {}
    result = handler_utils['get_user_id'](event)
    assert result is None


def test_report_telemetry_calls_quota_service(handler_utils):
    """Mock quota service, verify report_usage called."""
    mock_quota = MagicMock()
    mock_table = MagicMock()
    handler_utils['report_telemetry'](mock_quota, mock_table, 'user-1', 'test_op', count=2)
    mock_quota.report_usage.assert_called_once_with('user-1', 'test_op', count=2)


def test_report_telemetry_swallows_errors(handler_utils):
    """Verify exceptions are logged but not raised."""
    mock_quota = MagicMock()
    mock_quota.report_usage.side_effect = RuntimeError('DDB failure')
    mock_table = MagicMock()
    # Should not raise
    handler_utils['report_telemetry'](mock_quota, mock_table, 'user-1', 'test_op')


def test_report_telemetry_noop_when_no_quota_service(handler_utils):
    """Verify no-op when quota_service is None."""
    # Should not raise
    handler_utils['report_telemetry'](None, MagicMock(), 'user-1', 'test_op')


def test_report_telemetry_noop_when_no_user_id(handler_utils):
    """Verify no-op when user_id is empty."""
    mock_quota = MagicMock()
    handler_utils['report_telemetry'](mock_quota, MagicMock(), '', 'test_op')
    mock_quota.report_usage.assert_not_called()


def test_check_feature_gate_returns_403_when_gated(handler_utils):
    """Mock feature flag service returning False."""
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'features': {'advanced_analytics': False},
    }
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = handler_utils['check_feature_gate'](mock_ff, 'user-1', 'advanced_analytics', event)
    assert result is not None
    assert result['statusCode'] == 403


def test_check_feature_gate_returns_none_when_allowed(handler_utils):
    """Mock feature flag service returning True."""
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'features': {'advanced_analytics': True},
    }
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = handler_utils['check_feature_gate'](mock_ff, 'user-1', 'advanced_analytics', event)
    assert result is None


def test_check_feature_gate_returns_503_on_error(handler_utils):
    """Feature flag exception returns 503 (fail-closed)."""
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.side_effect = RuntimeError('DDB timeout')
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = handler_utils['check_feature_gate'](mock_ff, 'user-1', 'advanced_analytics', event)
    assert result is not None
    assert result['statusCode'] == 503


def test_check_feature_gate_returns_none_when_no_service(handler_utils):
    """No feature flag service means allow all."""
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = handler_utils['check_feature_gate'](None, 'user-1', 'advanced_analytics', event)
    assert result is None


def test_get_user_edges_cached_queries_once(handler_utils):
    """get_user_edges_cached calls edge_data_service once per user_id."""
    mock_edge_svc = MagicMock()
    mock_edge_svc.query_all_edges.return_value = [{'PK': 'USER#u1'}]
    cache = {}
    r1 = handler_utils['get_user_edges_cached'](mock_edge_svc, 'u1', cache)
    r2 = handler_utils['get_user_edges_cached'](mock_edge_svc, 'u1', cache)
    assert r1 == [{'PK': 'USER#u1'}]
    assert r2 == [{'PK': 'USER#u1'}]
    mock_edge_svc.query_all_edges.assert_called_once_with('u1')


def test_get_user_edges_cached_separate_users(handler_utils):
    """get_user_edges_cached caches per user_id independently."""
    mock_edge_svc = MagicMock()
    mock_edge_svc.query_all_edges.side_effect = lambda uid: [{'user': uid}]
    cache = {}
    r1 = handler_utils['get_user_edges_cached'](mock_edge_svc, 'u1', cache)
    r2 = handler_utils['get_user_edges_cached'](mock_edge_svc, 'u2', cache)
    assert r1 == [{'user': 'u1'}]
    assert r2 == [{'user': 'u2'}]
    assert mock_edge_svc.query_all_edges.call_count == 2
