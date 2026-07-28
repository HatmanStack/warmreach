"""Tests for shared handler utilities."""

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


def test_check_feature_gate_returns_503_on_infra_error(handler_utils):
    """A genuine infrastructure fault (DynamoDB ClientError) fails closed with 503."""
    from botocore.exceptions import ClientError

    mock_ff = MagicMock()
    mock_ff.get_feature_flags.side_effect = ClientError(
        {'Error': {'Code': 'InternalServerError', 'Message': 'DDB timeout'}}, 'GetItem'
    )
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = handler_utils['check_feature_gate'](mock_ff, 'user-1', 'advanced_analytics', event)
    assert result is not None
    assert result['statusCode'] == 503


def test_check_feature_gate_returns_503_on_not_found(handler_utils):
    """A missing tier (NotFoundError) is an entitlement-lookup failure: fail closed 503."""
    from errors.exceptions import NotFoundError

    mock_ff = MagicMock()
    mock_ff.get_feature_flags.side_effect = NotFoundError('User not found', resource_type='user', resource_id='user-1')
    event = {'headers': {'origin': 'http://localhost:5173'}}
    result = handler_utils['check_feature_gate'](mock_ff, 'user-1', 'advanced_analytics', event)
    assert result is not None
    assert result['statusCode'] == 503


def test_check_feature_gate_propagates_programming_error(handler_utils):
    """A programming error (not an infra fault) must propagate, not be masked as a 503,
    so a real bug surfaces as a 500 via the handler's outer catch (ADR-004)."""
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.side_effect = KeyError('bug')
    event = {'headers': {'origin': 'http://localhost:5173'}}
    with pytest.raises(KeyError):
        handler_utils['check_feature_gate'](mock_ff, 'user-1', 'advanced_analytics', event)


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

        table = self._make_table(
            {
                0: [[{'id': 'a'}, {'id': 'b'}]],
                1: [[{'id': 'c'}]],
                2: [[{'id': 'd'}, {'id': 'e'}]],
                3: [[{'id': 'f'}]],
            }
        )
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

        table = self._make_table(
            {
                0: [[{'id': 'a'}], [{'id': 'b'}]],
                1: [[{'id': 'c'}], [{'id': 'd'}]],
            }
        )
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


class TestParallelScanPartialFailure:
    """LOW #30: ``future.result()`` was called inline, so the first failing
    segment re-raised and discarded every other segment's completed pagination —
    the most expensive possible way to fail."""

    def _table_with_one_bad_segment(self, bad_segment, items_by_segment):
        table = MagicMock()

        def scan(**kwargs):
            segment = kwargs['Segment']
            if segment == bad_segment:
                raise RuntimeError(f'segment {segment} exploded')
            return {'Items': items_by_segment.get(segment, [])}

        table.scan.side_effect = scan
        return table

    def test_raises_partial_scan_error_carrying_the_other_segments_items(self):
        from shared_services.handler_utils import PartialScanError, parallel_scan

        table = self._table_with_one_bad_segment(2, {0: [{'PK': 'a'}], 1: [{'PK': 'b'}], 3: [{'PK': 'c'}]})

        with pytest.raises(PartialScanError) as excinfo:
            parallel_scan(table, total_segments=4)

        error = excinfo.value
        assert len(error.errors) == 1
        assert isinstance(error.errors[0], RuntimeError)
        # The surviving segments' work survives with it — that is the whole point.
        assert sorted(item['PK'] for item in error.items) == ['a', 'b', 'c']
        assert 'items were collected' in str(error)

    def test_every_failing_segment_is_reported_not_just_the_first(self):
        from shared_services.handler_utils import PartialScanError, parallel_scan

        table = MagicMock()

        def scan(**kwargs):
            if kwargs['Segment'] in (0, 2):
                raise RuntimeError('boom')
            return {'Items': [{'PK': f'seg-{kwargs["Segment"]}'}]}

        table.scan.side_effect = scan

        with pytest.raises(PartialScanError) as excinfo:
            parallel_scan(table, total_segments=4)
        assert len(excinfo.value.errors) == 2
        assert len(excinfo.value.items) == 2

    def test_all_healthy_segments_behave_exactly_as_before(self):
        """No behaviour change on the happy path — a plain list, no exception."""
        from shared_services.handler_utils import parallel_scan

        table = MagicMock()
        table.scan.side_effect = lambda **kwargs: {'Items': [{'PK': f'seg-{kwargs["Segment"]}'}]}

        items = parallel_scan(table, total_segments=3)
        assert isinstance(items, list)
        assert sorted(item['PK'] for item in items) == ['seg-0', 'seg-1', 'seg-2']

    def test_partial_data_is_never_returned_under_the_normal_return_type(self):
        """A silent partial answer is worse than a loud failure: an admin metric
        or a reconciliation sweep computed over a subset of the table is
        indistinguishable from a complete one."""
        from shared_services.handler_utils import PartialScanError, parallel_scan

        table = self._table_with_one_bad_segment(1, {0: [{'PK': 'a'}]})
        with pytest.raises(PartialScanError):
            parallel_scan(table, total_segments=2)


class TestDynamoDBResourceFactory:
    """LOW #27: default botocore timeouts are 60s connect / 60s read, which
    exceed the 30s Timeout on most of these functions, so a hung DynamoDB call
    became a hard Lambda kill rather than a catchable, retryable error."""

    def test_config_timeouts_are_below_the_smallest_lambda_timeout(self):
        from shared_services.aws_clients import DYNAMODB_CLIENT_CONFIG_KWARGS

        assert DYNAMODB_CLIENT_CONFIG_KWARGS['connect_timeout'] == 3
        assert DYNAMODB_CLIENT_CONFIG_KWARGS['read_timeout'] == 5
        # The per-attempt worst case must fit inside every DynamoDB caller's own
        # Timeout; test_template_shape asserts that against the real templates.
        assert DYNAMODB_CLIENT_CONFIG_KWARGS['connect_timeout'] + DYNAMODB_CLIENT_CONFIG_KWARGS['read_timeout'] <= 30

    def test_retries_are_adaptive(self):
        from shared_services.aws_clients import DYNAMODB_CLIENT_CONFIG_KWARGS

        assert DYNAMODB_CLIENT_CONFIG_KWARGS['retries'] == {'max_attempts': 3, 'mode': 'adaptive'}

    def test_each_factory_call_gets_its_own_config_instance(self):
        """botocore normalises a Config in place when it builds a client, so a
        shared module-level instance would stop matching its own declaration
        after the first use and would alias every caller."""
        from shared_services.aws_clients import DYNAMODB_CLIENT_CONFIG_KWARGS, dynamodb_client, dynamodb_config

        first = dynamodb_config()
        assert dynamodb_config() is not first

        dynamodb_client(region_name='us-east-1')  # mutates whatever Config it is handed
        assert DYNAMODB_CLIENT_CONFIG_KWARGS['retries'] == {'max_attempts': 3, 'mode': 'adaptive'}
        assert dynamodb_config().retries == {'max_attempts': 3, 'mode': 'adaptive'}

    def test_the_resource_carries_the_config(self):
        from shared_services.aws_clients import dynamodb_resource

        resource = dynamodb_resource(region_name='us-east-1')
        config = resource.meta.client.meta.config
        assert config.connect_timeout == 3
        assert config.read_timeout == 5

    def test_the_client_carries_the_same_config(self):
        from shared_services.aws_clients import dynamodb_client

        config = dynamodb_client(region_name='us-east-1').meta.config
        assert config.connect_timeout == 3
        assert config.read_timeout == 5

    def test_the_low_level_client_shares_the_resource_config(self):
        """The two factories must not drift: a caller reaching for
        transact_write_items should get the same bounds as a caller reaching
        for a Table."""
        from shared_services.aws_clients import DYNAMODB_CLIENT_CONFIG_KWARGS, dynamodb_client, dynamodb_resource

        client_config = dynamodb_client(region_name='us-east-1').meta.config
        resource_config = dynamodb_resource(region_name='us-east-1').meta.client.meta.config
        for attribute in ('connect_timeout', 'read_timeout'):
            assert getattr(client_config, attribute) == DYNAMODB_CLIENT_CONFIG_KWARGS[attribute]
            assert getattr(resource_config, attribute) == DYNAMODB_CLIENT_CONFIG_KWARGS[attribute]

    def test_no_unconfigured_low_level_client_sites_remain(self):
        """The low-level client half of the migration.

        ``boto3.client('dynamodb')`` backs transact_write_items on the
        claim-before-send path, where the default 60s read timeout is a 6x
        mismatch against CommandDispatchFunction's 10s budget — so a hung call
        was a hard Lambda kill rather than a catchable, retryable error.
        """
        import subprocess
        from pathlib import Path

        repo = Path(__file__).resolve().parents[3]
        result = subprocess.run(
            ['grep', '-rl', "boto3.client('dynamodb')", 'backend/lambdas', '.sync/overlays/backend', '--include=*.py'],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        leftover = [line for line in result.stdout.split() if line]
        assert leftover == [], f'un-migrated DynamoDB client construction sites: {leftover}'

    def test_the_factory_is_the_only_unconfigured_construction_site_left(self):
        """The completeness proof for the migration. Scoped to a literal search
        over the tree rather than to imports, because the failure mode is a call
        site that quietly kept constructing its own resource."""
        import subprocess
        from pathlib import Path

        repo = Path(__file__).resolve().parents[3]
        result = subprocess.run(
            [
                'grep',
                '-rl',
                "boto3.resource('dynamodb')",
                'backend/lambdas',
                '.sync/overlays/backend',
                '--include=*.py',
            ],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        leftover = [line for line in result.stdout.split() if line]
        # aws_clients.py's own call passes config=, so it does not match either.
        assert leftover == [], f'un-migrated DynamoDB construction sites: {leftover}'


class TestParallelScanItemCap(TestParallelScan):
    """Phase-4 Task 1: an unbounded accumulation behind a 512MB Lambda OOMs
    before it times out — a hard cliff, not a slowdown. ``max_items`` degrades to
    a truncated answer instead, and says so."""

    def test_no_cap_reports_untruncated(self):
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({0: [[{'id': 'a'}]], 1: [[{'id': 'b'}]]})
        result = parallel_scan(table, total_segments=2)
        assert result.truncated is False

    def test_the_cap_stops_collection_and_reports_truncation(self):
        from shared_services.handler_utils import parallel_scan

        # 4 segments x 3 pages x 2 items = 24 items available; cap at 5.
        pages = [[{'id': 'x'}, {'id': 'y'}] for _ in range(3)]
        table = self._make_table(dict.fromkeys(range(4), pages))
        result = parallel_scan(table, total_segments=4, max_items=5)
        assert len(result) == 5
        assert result.truncated is True

    def test_the_cap_is_enforced_per_page_not_after_collection(self):
        """The point of the cap is that the surplus items are never
        materialised. Applied after collection, the process would already have
        OOMed."""
        from shared_services.handler_utils import parallel_scan

        # One segment, ten pages. With a cap of 2 only the first page may be
        # fetched; a post-hoc slice would have paginated all ten.
        pages = [[{'id': f'p{i}a'}, {'id': f'p{i}b'}] for i in range(10)]
        table = self._make_table({0: pages})
        result = parallel_scan(table, total_segments=1, max_items=2)
        assert len(result) == 2
        assert result.truncated is True
        assert len(table._call_log) == 1

    def test_a_cap_that_exactly_matches_the_table_is_not_truncation(self):
        """``truncated`` must mean "items were dropped", not "the cap was
        reached" — otherwise every exact-fit scan raises a false alarm."""
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({0: [[{'id': 'a'}, {'id': 'b'}]]})
        result = parallel_scan(table, total_segments=1, max_items=2)
        assert len(result) == 2
        assert result.truncated is False

    def test_the_result_is_still_an_ordinary_list_for_every_existing_caller(self):
        from shared_services.handler_utils import parallel_scan

        table = self._make_table({0: [[{'id': 'a'}]]})
        result = parallel_scan(table, total_segments=1, max_items=10)
        assert isinstance(result, list)
        assert result == [{'id': 'a'}]

    def test_a_segment_aborted_before_its_first_page_reports_truncation(self):
        """A segment stopped by another segment's budget consumption cannot
        prove it was empty. Reporting the result as possibly-incomplete is the
        conservative answer; the alternative silently under-reports truncation
        whenever the budget lands exactly on a page boundary."""
        from shared_services.handler_utils import parallel_scan

        table = self._make_table(dict.fromkeys(range(4), [[{'id': 'a'}, {'id': 'b'}]]))
        result = parallel_scan(table, total_segments=4, max_items=2)
        assert len(result) == 2
        assert result.truncated is True

    def test_a_multi_segment_scan_under_its_cap_is_not_truncated(self):
        """The conservative rule must not fire when no segment was ever stopped."""
        from shared_services.handler_utils import parallel_scan

        table = self._make_table(dict.fromkeys(range(4), [[{'id': 'a'}]]))
        result = parallel_scan(table, total_segments=4, max_items=100)
        assert len(result) == 4
        assert result.truncated is False
