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


class TestParseDays:
    """Tests for parse_days helper used by analytics-insights handlers."""

    def test_returns_valid_int_from_string(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({'days': '7'}) == 7

    def test_returns_valid_int_from_number(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({'days': 42}) == 42

    def test_default_when_missing(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({}) == 30
        assert parse_days(None) == 30
        assert parse_days({'other': 1}) == 30

    def test_clamps_to_max(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({'days': 500}) == 365
        assert parse_days({'days': '9999'}) == 365

    def test_fallback_on_non_numeric(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({'days': 'banana'}) == 30
        assert parse_days({'days': None}) == 30

    def test_zero_and_negative_return_default(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({'days': 0}) == 30
        assert parse_days({'days': -5}) == 30

    def test_honors_custom_bounds(self):
        from shared_services.handler_utils import parse_days
        assert parse_days({'days': 50}, default=7, max_=30) == 30
        assert parse_days({}, default=7, max_=30) == 7


class TestParallelScan:
    """Tests for the parallel_scan helper (Phase-4 Task 9)."""

    def _make_table(self, items_by_segment):
        """Build a MagicMock table whose scan() responds per-Segment.

        ``items_by_segment`` is a dict: {segment_index: list_of_pages}
        where each page is a list of items. The last page of a segment
        has no LastEvaluatedKey so pagination stops.
        """
        table = MagicMock()
        call_log = []

        def scan(**kwargs):
            call_log.append(kwargs)
            segment = kwargs['Segment']
            pages = items_by_segment.get(segment, [[]])
            # Advance based on how many times this segment has been called.
            seg_calls = sum(1 for c in call_log if c['Segment'] == segment)
            page_idx = seg_calls - 1
            if page_idx >= len(pages):
                return {'Items': []}
            items = pages[page_idx]
            response = {'Items': items}
            if page_idx < len(pages) - 1:
                response['LastEvaluatedKey'] = {'PK': f'cursor-{segment}-{page_idx}'}
            return response

        table.scan.side_effect = scan
        table._call_log = call_log
        return table

    def test_fans_out_across_segments_and_collects_all_items(self):
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({
            0: [[{'id': 'a'}, {'id': 'b'}]],
            1: [[{'id': 'c'}]],
            2: [[{'id': 'd'}, {'id': 'e'}]],
            3: [[{'id': 'f'}]],
        })
        items = parallel_scan(table, total_segments=4)
        ids = sorted(i['id'] for i in items)
        assert ids == ['a', 'b', 'c', 'd', 'e', 'f']
        # All four segments were invoked.
        segments_seen = {c['Segment'] for c in table._call_log}
        assert segments_seen == {0, 1, 2, 3}
        # Every call carries TotalSegments matching the helper arg.
        assert all(c['TotalSegments'] == 4 for c in table._call_log)

    def test_paginates_each_segment(self):
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({
            0: [[{'id': 'a'}], [{'id': 'b'}]],
            1: [[{'id': 'c'}], [{'id': 'd'}]],
        })
        items = parallel_scan(table, total_segments=2)
        assert sorted(i['id'] for i in items) == ['a', 'b', 'c', 'd']
        # Each segment produced two calls (page 1 + page 2).
        seg0_calls = [c for c in table._call_log if c['Segment'] == 0]
        seg1_calls = [c for c in table._call_log if c['Segment'] == 1]
        assert len(seg0_calls) == 2
        assert len(seg1_calls) == 2
        # The second page carries ExclusiveStartKey.
        assert 'ExclusiveStartKey' in seg0_calls[1]

    def test_forwards_filter_expression(self):
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({0: [[]], 1: [[]]})
        parallel_scan(
            table,
            total_segments=2,
            scan_kwargs={
                'FilterExpression': 'begins_with(SK, :sk)',
                'ExpressionAttributeValues': {':sk': 'TIER#current'},
            },
        )
        for call in table._call_log:
            assert call['FilterExpression'] == 'begins_with(SK, :sk)'
            assert call['ExpressionAttributeValues'] == {':sk': 'TIER#current'}

    def test_rejects_caller_segment_and_total_segments(self):
        """Caller-supplied Segment/TotalSegments must be ignored (helper manages)."""
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({0: [[]], 1: [[]]})
        parallel_scan(
            table,
            total_segments=2,
            scan_kwargs={'Segment': 99, 'TotalSegments': 99, 'FilterExpression': 'x'},
        )
        for call in table._call_log:
            assert call['Segment'] in (0, 1)
            assert call['TotalSegments'] == 2
            assert call['FilterExpression'] == 'x'
