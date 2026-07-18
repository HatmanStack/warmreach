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
    # a real boto3 resource, but we never hit it — parallel_scan is patched).
    module.table = MagicMock()
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
    reconciler.parallel_scan = lambda *a, **k: items
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
    reconciler.parallel_scan = lambda *a, **k: items
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
    reconciler.parallel_scan = lambda *a, **k: items
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
    assert summary == {'scanned': 0, 'reconciled': 0, 'completed': 0, 'abandoned': 0, 'errors': 0}


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
    reconciler.parallel_scan = lambda *a, **k: items
    reconciler._get_service = lambda: svc

    summary = reconciler.lambda_handler({}, None)

    svc._set_research_status.assert_any_call('u1', 'naive', 'abandoned')
    assert summary['abandoned'] == 1
