"""Unit tests for the research reconciler Lambda (reconcile_handler)."""
import importlib.util
import sys
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from conftest import BACKEND_LAMBDAS, SHARED_PYTHON


def _load_reconciler():
    """Load reconcile_handler.py with the shared layer on sys.path."""
    path = BACKEND_LAMBDAS / 'llm' / 'reconcile_handler.py'
    spec = importlib.util.spec_from_file_location('reconcile_handler_under_test', path)
    module = importlib.util.module_from_spec(spec)
    lambda_dir = str(BACKEND_LAMBDAS / 'llm')
    shared_dir = str(SHARED_PYTHON)
    original = sys.path.copy()
    for name in list(sys.modules.keys()):
        if name.startswith(('services', 'errors', 'models', 'shared_services')):
            del sys.modules[name]
    sys.path[:] = [shared_dir, lambda_dir] + [p for p in original if p not in (shared_dir, lambda_dir)]
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = original
    return module


@pytest.fixture
def reconciler():
    module = _load_reconciler()
    # Ensure the handler treats storage as configured (module-level table may be
    # a real boto3 resource, but we never hit it — the index query is patched).
    module.table = MagicMock()
    # Pin the hourly index-verification sweep off. It is wall-clock driven, so
    # leaving it live would make every test here behave differently between
    # :00 and :05. Tests that exercise the sweep turn it on explicitly.
    module._should_sweep = lambda: False
    return module


def _now():
    return datetime.now(UTC)


def _iso(dt):
    return dt.isoformat()


def test_reconciles_newest_and_abandons_older(reconciler):
    now = _now()
    items = [
        {
            'PK': 'USER#u1',
            'SK': 'RESEARCH#old',
            'status': 'in_progress',
            'openai_response_id': 'r_old',
            'created_at': _iso(now - timedelta(minutes=2)),
        },
        {
            'PK': 'USER#u1',
            'SK': 'RESEARCH#new',
            'status': 'in_progress',
            'openai_response_id': 'r_new',
            'created_at': _iso(now),
        },
    ]
    svc = MagicMock()
    svc.get_research_result.return_value = {'success': True, 'content': 'done'}
    reconciler._query_active_research = lambda: items
    reconciler._get_service = lambda: svc

    summary = reconciler.lambda_handler({}, None)

    # Only the newest active job is reconciled/mirrored.
    svc.get_research_result.assert_called_once_with('u1', 'new', 'RESEARCH')
    # The older (superseded) job is abandoned, never reconciled.
    svc._set_research_status.assert_any_call('u1', 'old', 'abandoned')
    assert summary['completed'] == 1
    assert summary['abandoned'] == 1


def test_stale_primary_is_abandoned_not_reconciled(reconciler):
    now = _now()
    items = [
        {
            'PK': 'USER#u1',
            'SK': 'RESEARCH#zombie',
            'status': 'in_progress',
            'openai_response_id': 'r_zombie',
            'created_at': _iso(now - timedelta(hours=reconciler.STALE_RESEARCH_HOURS + 1)),
        },
    ]
    svc = MagicMock()
    reconciler._query_active_research = lambda: items
    reconciler._get_service = lambda: svc

    summary = reconciler.lambda_handler({}, None)

    # A 6h+ old in-progress job is a zombie: abandoned, never mirrored, so it
    # can't clobber the profile's current research.
    svc._set_research_status.assert_any_call('u1', 'zombie', 'abandoned')
    svc.get_research_result.assert_not_called()
    assert summary['abandoned'] == 1
    assert summary['reconciled'] == 0


def test_starting_job_without_response_id_is_left_alone(reconciler):
    now = _now()
    items = [
        {
            'PK': 'USER#u1',
            'SK': 'RESEARCH#fresh',
            'status': 'starting',
            'created_at': _iso(now),
        },
    ]
    svc = MagicMock()
    reconciler._query_active_research = lambda: items
    reconciler._get_service = lambda: svc

    summary = reconciler.lambda_handler({}, None)

    # Mid-kickoff row (no response id yet): don't reconcile, don't abandon.
    svc.get_research_result.assert_not_called()
    svc._set_research_status.assert_not_called()
    assert summary['reconciled'] == 0
    assert summary['abandoned'] == 0


def test_no_table_is_a_noop(reconciler):
    reconciler.table = None
    summary = reconciler.lambda_handler({}, None)
    assert summary == {
        'scanned': 0,
        'unindexed': 0,
        'reconciled': 0,
        'completed': 0,
        'abandoned': 0,
        'errors': 0,
    }


def test_naive_created_at_does_not_abort_the_run(reconciler):
    # A row whose created_at lacks a tz offset must not raise a TypeError that
    # aborts the whole reconciliation pass (parse_iso_datetime returns aware).
    items = [
        {
            'PK': 'USER#u1',
            'SK': 'RESEARCH#naive',
            'status': 'in_progress',
            'openai_response_id': 'r',
            'created_at': '2020-01-01T00:00:00',  # naive + very old -> stale
        }
    ]
    svc = MagicMock()
    reconciler._query_active_research = lambda: items
    reconciler._get_service = lambda: svc

    summary = reconciler.lambda_handler({}, None)

    svc._set_research_status.assert_any_call('u1', 'naive', 'abandoned')
    assert summary['abandoned'] == 1


# --- Sparse GSI3 reconciliation index ----------------------------------------
#
# The reconciler now reads its work from an index instead of scanning the whole
# table. That is only correct while every write path maintains the keys: a row
# that misses them becomes permanently invisible to the reconciler, and nothing
# would report it. These cover both halves — the index being read, and the
# safety net that makes a missed write path loud.


def test_reads_the_index_not_the_table(reconciler):
    # The whole point: a tick must cost O(in-flight jobs), not O(table size).
    reconciler.parallel_scan = lambda *a, **k: pytest.fail(
        'reconciler fell back to a full-table scan on a normal tick'
    )
    reconciler.table.query = MagicMock(return_value={'Items': []})
    reconciler._get_service = lambda: MagicMock()

    reconciler.lambda_handler({}, None)

    kwargs = reconciler.table.query.call_args.kwargs
    assert kwargs['IndexName'] == 'GSI3'
    assert kwargs['ExpressionAttributeValues'][':pk'] == reconciler.RESEARCH_RECON_PARTITION


def test_index_query_follows_pagination(reconciler):
    first = {'Items': [{'PK': 'USER#u1', 'SK': 'RESEARCH#a'}], 'LastEvaluatedKey': {'k': 1}}
    second = {'Items': [{'PK': 'USER#u1', 'SK': 'RESEARCH#b'}]}
    reconciler.table.query = MagicMock(side_effect=[first, second])

    assert len(reconciler._query_active_research()) == 2


def test_sweep_reports_rows_the_index_missed(reconciler):
    # A silent miss is the failure mode this sweep exists to convert into a
    # loud one.
    indexed = [{'PK': 'USER#u1', 'SK': 'RESEARCH#indexed', 'status': 'in_progress'}]
    orphan = {'PK': 'USER#u2', 'SK': 'RESEARCH#orphan', 'status': 'in_progress'}
    reconciler.parallel_scan = lambda *a, **k: indexed + [orphan]

    assert reconciler._sweep_for_unindexed(indexed) == [orphan]


def test_sweep_is_quiet_when_the_index_is_complete(reconciler):
    rows = [{'PK': 'USER#u1', 'SK': 'RESEARCH#a', 'status': 'in_progress'}]
    reconciler.parallel_scan = lambda *a, **k: rows

    assert reconciler._sweep_for_unindexed(rows) == []


def test_unindexed_rows_are_still_reconciled(reconciler):
    # Rows predating the index — or missed by a buggy write path — must not be
    # stranded. The sweep folds them back into the run.
    now = _now()
    orphan = {
        'PK': 'USER#u9',
        'SK': 'RESEARCH#orphan',
        'status': 'in_progress',
        'openai_response_id': 'r_orphan',
        'created_at': _iso(now),
    }
    reconciler._query_active_research = lambda: []
    reconciler.parallel_scan = lambda *a, **k: [orphan]
    reconciler._should_sweep = lambda: True
    svc = MagicMock()
    svc.get_research_result.return_value = {'success': True, 'content': 'done'}
    reconciler._get_service = lambda: svc

    summary = reconciler.lambda_handler({}, None)

    svc.get_research_result.assert_called_once_with('u9', 'orphan', 'RESEARCH')
    assert summary['unindexed'] == 1
    assert summary['completed'] == 1
