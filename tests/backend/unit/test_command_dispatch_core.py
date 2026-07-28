"""Unit tests for the community-clean ``command_dispatch_core`` module.

The core hosts the create + atomic rate-limit + WebSocket-dispatch path shared by
``command-dispatch`` (POST /commands) and both send gates (``linkedin-action-gate``
and the agent ``gate_dispatch``). These tests exercise the core directly:

- the ``create_command`` status branches — 200 dispatched / 409 no-agent /
  429 rate-limited / 503 disconnected / 503 rate-limit-unavailable;
- the atomicity of ``_reserve_and_create_command`` (rate-limit + create commit
  together, or neither);
- ADR-009: the module imports nothing pro/agent/quota.
"""

import json
import logging
import os
import sys
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'
os.environ['WEBSOCKET_ENDPOINT'] = 'https://test.execute-api.us-east-1.amazonaws.com/dev'
os.environ['ALLOWED_ORIGINS'] = 'http://localhost:5173'
os.environ['LOG_LEVEL'] = 'DEBUG'

USER = 'user-123'


@pytest.fixture
def ws_table(aws_credentials):
    with mock_aws():
        import boto3

        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'GSI1',
                    'KeySchema': [
                        {'AttributeName': 'GSI1PK', 'KeyType': 'HASH'},
                        {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'},
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
                }
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )
        yield table


@pytest.fixture
def core(ws_table):
    """Freshly load ``command_dispatch_core`` inside the moto context and point its
    module-level ``table`` at the moto table.

    ``load_lambda_module`` clears + re-imports ``shared_services`` with ``shared/python``
    on ``sys.path``, so importing command-dispatch (which imports the core) loads a
    clean core whose ``table``/``ddb_client`` bind to the active moto backend.
    """
    from conftest import load_lambda_module

    load_lambda_module('command-dispatch')
    mod = sys.modules['shared_services.command_dispatch_core']
    mod.table = ws_table
    return mod


def _seed_agent(table, user=USER):
    table.put_item(
        Item={
            'PK': 'WSCONN#agent-conn-1',
            'SK': '#METADATA',
            'GSI1PK': f'USER#{user}#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'agent-conn-1',
            'userSub': user,
            'clientType': 'agent',
            'connectedAt': 1000,
        }
    )


# --- ADR-009: the shared core is community-clean ------------------------------
def test_core_imports_nothing_pro():
    """The core must not IMPORT quota/monetization/agent modules (ADR-009). Only the
    imported module names are inspected — the docstring may reference the boundary."""
    import ast

    from conftest import SHARED_PYTHON

    src = (SHARED_PYTHON / 'shared_services' / 'command_dispatch_core.py').read_text()
    imported: list[str] = []
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.append(node.module or '')
            imported.extend(f'{node.module or ""}.{alias.name}' for alias in node.names)

    forbidden = ('monetization', 'quota', 'opportunity_action', 'gate_dispatch', 'agent')
    offenders = [name for name in imported for token in forbidden if token in name]
    assert not offenders, f'command_dispatch_core must stay community-clean; forbidden imports: {offenders}'


def test_core_imports_nothing_pro_transitively():
    """The AST check above inspects DIRECT imports only, so a helper that is
    itself clean but pulls monetization in behind it would pass it while
    breaching ADR-009 all the same.

    This is not hypothetical. The Phase-3 plan specified the shared DynamoDB
    resource factory as ``handler_utils.dynamodb_resource()``, and
    ``handler_utils`` imports ``shared_services.monetization`` at module scope —
    routing the core through it would have put
    ``monetization -> quota_service/tier_service/feature_flag_service`` in this
    module's import graph with every existing gate still green. The factory
    lives in the ``aws_clients`` leaf instead, and this test is what keeps it
    there.
    """
    import subprocess

    from conftest import SHARED_PYTHON

    script = (
        'import sys, json\n'
        'before = set(sys.modules)\n'
        'import shared_services.command_dispatch_core  # noqa: F401\n'
        "print(json.dumps(sorted(m for m in set(sys.modules) - before if m.startswith('shared_services.'))))\n"
    )
    env = dict(os.environ, PYTHONPATH=str(SHARED_PYTHON), DYNAMODB_TABLE_NAME='test-table')
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, env=env, timeout=60)
    assert result.returncode == 0, result.stderr
    modules = json.loads(result.stdout.strip().splitlines()[-1])

    forbidden = ('monetization', 'quota', 'tier_service', 'feature_flag', 'opportunity_action', 'gate_dispatch')
    offenders = [m for m in modules for token in forbidden if token in m]
    assert not offenders, (
        f'command_dispatch_core reaches pro/quota modules transitively: {offenders} (full graph: {modules})'
    )


# --- create_command status branches ------------------------------------------
def test_create_command_dispatches_returns_200(core, ws_table):
    _seed_agent(ws_table)
    with patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True):
        status, body = core.create_command(USER, 'linkedin:search', {'query': 'x'})

    assert status == 200
    assert body['status'] == 'dispatched'
    assert 'commandId' in body
    stored = ws_table.get_item(Key={'PK': f'COMMAND#{body["commandId"]}', 'SK': '#METADATA'}).get('Item')
    assert stored is not None
    assert stored['status'] == 'dispatched'
    assert stored['type'] == 'linkedin:search'
    assert stored['cognitoSub'] == USER


def test_create_command_no_agent_returns_409(core, ws_table):
    # No agent connection seeded.
    status, body = core.create_command(USER, 'linkedin:search', {})
    assert status == 409
    assert body['error'] == 'No agent connected'


def test_create_command_table_not_configured_raises_runtime_error(core, ws_table):
    """A misconfigured deploy (no DYNAMODB_TABLE_NAME -> module table is None)
    surfaces a clear config RuntimeError from create_command, not an opaque NoneType
    AttributeError deeper in the send path. Because TABLE_NAME is now read (not
    hard-indexed) at import, merely importing the module never KeyErrors, so the
    agent gate's `table = ... if TABLE_NAME else None` graceful guard is preserved."""
    core.table = None
    with pytest.raises(RuntimeError, match='DYNAMODB_TABLE_NAME'):
        core.create_command(USER, 'linkedin:search', {})


def test_create_command_agent_lookup_failure_returns_503_not_raises(core, ws_table):
    """A pre-dispatch agent-connection LOOKUP failure is strictly not-sent, so it
    returns a clean 503 (AGENT_LOOKUP_UNAVAILABLE) rather than raising. This keeps the
    raise channel EXCLUSIVELY at/after the WebSocket dispatch (maybe-sent), which both
    gates rely on to decide whether to refund quota on a raised create_command."""
    with patch(
        'shared_services.websocket_service.WebSocketService.get_user_connections',
        side_effect=RuntimeError('ddb throttled'),
    ):
        status, body = core.create_command(USER, 'linkedin:search', {})
    assert status == 503
    assert body['code'] == 'AGENT_LOOKUP_UNAVAILABLE'


def test_create_command_rate_limited_returns_429(core, ws_table):
    _seed_agent(ws_table)
    with patch.object(core, '_reserve_and_create_command', side_effect=core.RateLimitExceededError()):
        status, body = core.create_command(USER, 'linkedin:search', {})
    assert status == 429
    assert body['code'] == 'RATE_LIMITED'
    assert 'retryAfter' in body


def test_create_command_rate_limit_unavailable_returns_503(core, ws_table):
    _seed_agent(ws_table)
    with patch.object(core, '_reserve_and_create_command', side_effect=core.RateLimitUnavailableError('x')):
        status, body = core.create_command(USER, 'linkedin:search', {})
    assert status == 503
    assert body['code'] == 'RATE_LIMIT_UNAVAILABLE'


def test_create_command_agent_disconnected_mid_send_returns_503(core, ws_table):
    _seed_agent(ws_table)
    with patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=False):
        status, body = core.create_command(USER, 'linkedin:search', {})
    assert status == 503
    assert body['error'] == 'Agent disconnected'
    assert body['status'] == 'failed'
    assert 'commandId' in body
    # The record was marked failed (not left pending).
    stored = ws_table.get_item(Key={'PK': f'COMMAND#{body["commandId"]}', 'SK': '#METADATA'}).get('Item')
    assert stored['status'] == 'failed'


def test_create_command_emits_activity_on_success(core, ws_table):
    _seed_agent(ws_table)
    with (
        patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True),
        patch.object(core, 'write_activity') as mock_wa,
    ):
        status, _ = core.create_command(USER, 'linkedin:search', {'query': 'x'})

    assert status == 200
    mock_wa.assert_called_once()
    assert mock_wa.call_args[0][2] == 'command_dispatched'
    assert mock_wa.call_args[1]['metadata']['commandType'] == 'linkedin:search'


def test_create_command_post_send_exception_propagates(core, ws_table):
    """A post-send failure on work that MATTERS must PROPAGATE, not be swallowed —
    it is the ambiguous-outcome signal the agent gate relies on (a real send may
    already have happened, so callers must not revert).

    The example is the ``dispatched`` status write: if that fails, the COMMAND#
    genuinely disagrees with reality. It used to be ``write_activity``, but the
    activity timeline records what happened rather than deciding whether it
    happened, so it moved off this channel — see
    ``test_activity_write_failure_still_returns_200``."""
    _seed_agent(ws_table)
    with (
        patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True),
        patch.object(core.table, 'update_item', side_effect=RuntimeError('post-send boom')),
    ):
        with pytest.raises(RuntimeError, match='post-send boom'):
            core.create_command(USER, 'linkedin:search', {})


# --- MEDIUM #15: cosmetic post-send work must not fail a completed send -------
def _seed_browser(table, user=USER):
    table.put_item(
        Item={
            'PK': 'WSCONN#browser-conn-1',
            'SK': '#METADATA',
            'GSI1PK': f'USER#{user}#WSCONN',
            'GSI1SK': 'TYPE#browser',
            'connectionId': 'browser-conn-1',
            'userSub': user,
            'clientType': 'browser',
            'connectedAt': 1000,
        }
    )


def _agent_ok_browser_raises(exc):
    """send_to_connection stub: the agent dispatch succeeds, the browser
    notification that follows it raises."""

    def _send(self, connection_id, data):
        if connection_id.startswith('browser'):
            raise exc
        return True

    return _send


@pytest.mark.parametrize('code', ['LimitExceededException', 'PayloadTooLargeException'])
def test_browser_notify_client_error_still_returns_200(core, ws_table, caplog, code):
    """send_to_connection re-raises every ClientError except GoneException, so a
    @connections throttle on a *cosmetic browser notification* used to propagate
    out of create_command. The gate reads any raise as maybe-sent and returns
    503 — reporting a LinkedIn action that fully succeeded as a failure."""
    from botocore.exceptions import ClientError

    _seed_agent(ws_table)
    _seed_browser(ws_table)
    err = ClientError({'Error': {'Code': code, 'Message': 'x'}}, 'PostToConnection')
    with patch(
        'shared_services.websocket_service.WebSocketService.send_to_connection',
        _agent_ok_browser_raises(err),
    ):
        with caplog.at_level(logging.ERROR):
            status, body = core.create_command(USER, 'linkedin:search', {'query': 'x'})

    assert status == 200
    assert body['status'] == 'dispatched'
    assert any(r.exc_info is not None for r in caplog.records), 'the swallowed error must still be logged'


def test_browser_connection_lookup_failure_still_returns_200(core, ws_table, caplog):
    """The browser-connection query is the same DynamoDB call that can throttle,
    and it is just as cosmetic as the notification it feeds — so it sits inside
    the same guard rather than one statement outside it."""
    _seed_agent(ws_table)

    def _lookup(self, user_sub, client_type=None):
        if client_type == 'browser':
            raise RuntimeError('query throttled')
        return [{'connectionId': 'agent-conn-1'}]

    with (
        patch('shared_services.websocket_service.WebSocketService.get_user_connections', _lookup),
        patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True),
    ):
        with caplog.at_level(logging.ERROR):
            status, body = core.create_command(USER, 'linkedin:search', {})

    assert status == 200
    assert body['status'] == 'dispatched'
    assert any(r.exc_info is not None for r in caplog.records)


def test_activity_write_failure_still_returns_200(core, ws_table, caplog):
    """The activity timeline is a record, not a correctness input."""
    _seed_agent(ws_table)
    with (
        patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True),
        patch.object(core, 'write_activity', side_effect=RuntimeError('activity boom')),
    ):
        with caplog.at_level(logging.ERROR):
            status, body = core.create_command(USER, 'linkedin:search', {})

    assert status == 200
    assert body['status'] == 'dispatched'
    assert any(r.exc_info is not None for r in caplog.records)


def test_gone_browser_connection_is_still_reaped(core, ws_table):
    """The GoneException self-heal is unchanged: send_to_connection deletes the
    stale WSCONN# and returns False rather than raising, so swallowing the other
    ClientErrors did not paper over this path."""
    from shared_services.websocket_service import WebSocketService

    _seed_agent(ws_table)
    _seed_browser(ws_table)
    from botocore.exceptions import ClientError

    ws = WebSocketService(ws_table, '')
    ws.apigw = MagicMock()
    ws.apigw.post_to_connection.side_effect = ClientError(
        {'Error': {'Code': 'GoneException', 'Message': 'x'}}, 'PostToConnection'
    )

    assert ws.send_to_connection('browser-conn-1', {'a': 1}) is False
    assert ws_table.get_item(Key={'PK': 'WSCONN#browser-conn-1', 'SK': '#METADATA'}).get('Item') is None


# --- _reserve_and_create_command atomicity (rate-limit + create) --------------
def test_rate_limit_conditional_check_raises_rate_limit_exceeded(core, ws_table):
    """TransactionCanceledException with ConditionalCheckFailed on the rate-limit
    update maps to RateLimitExceededError, and no command record is persisted."""
    from botocore.exceptions import ClientError

    error = ClientError(
        {
            'Error': {'Code': 'TransactionCanceledException', 'Message': 'canceled'},
            'CancellationReasons': [{'Code': 'ConditionalCheckFailed'}, {'Code': 'None'}],
        },
        'TransactWriteItems',
    )
    with patch.object(core.ddb_client, 'transact_write_items', side_effect=error):
        with pytest.raises(core.RateLimitExceededError):
            core._reserve_and_create_command(USER, 'cmd-1', 't', {})

    assert ws_table.get_item(Key={'PK': 'COMMAND#cmd-1', 'SK': '#METADATA'}).get('Item') is None


def test_put_condition_failure_rolls_back_rate_limit_increment(core, ws_table):
    """If the Put side of the transaction fails, the rate-limit increment must also
    be rolled back (atomicity)."""
    from botocore.exceptions import ClientError

    error = ClientError(
        {
            'Error': {'Code': 'TransactionCanceledException', 'Message': 'canceled'},
            'CancellationReasons': [{'Code': 'None'}, {'Code': 'ConditionalCheckFailed'}],
        },
        'TransactWriteItems',
    )
    with patch.object(core.ddb_client, 'transact_write_items', side_effect=error):
        with pytest.raises(core.RateLimitUnavailableError):
            core._reserve_and_create_command(USER, 'cmd-2', 't', {})

    assert ws_table.get_item(Key={'PK': 'COMMAND#cmd-2', 'SK': '#METADATA'}).get('Item') is None


def test_unexpected_client_error_raises_unavailable(core, ws_table):
    """Unexpected ClientError (not TransactionCanceledException) must raise RateLimitUnavailableError."""
    from botocore.exceptions import ClientError

    error = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'DDB failure'}}, 'TransactWriteItems')
    with patch.object(core.ddb_client, 'transact_write_items', side_effect=error):
        with pytest.raises(core.RateLimitUnavailableError):
            core._reserve_and_create_command(USER, 'cmd-3', 't', {})


def test_generic_exception_raises_unavailable(core, ws_table):
    """Generic Exception must raise RateLimitUnavailableError (fail closed)."""
    with patch.object(core.ddb_client, 'transact_write_items', side_effect=RuntimeError('boom')):
        with pytest.raises(core.RateLimitUnavailableError):
            core._reserve_and_create_command(USER, 'cmd-4', 't', {})


def test_provisioned_throughput_exceeded_does_not_return_429(core, ws_table):
    """ProvisionedThroughputExceededException is a backend error, not a rate-limit
    hit; it must not surface as 429 (which would trigger the wrong client retry)."""
    from botocore.exceptions import ClientError

    error = ClientError(
        {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'hot partition'}},
        'TransactWriteItems',
    )
    with patch.object(core.ddb_client, 'transact_write_items', side_effect=error):
        with pytest.raises(core.RateLimitUnavailableError):
            core._reserve_and_create_command(USER, 'cmd-5', 't', {})


def test_successful_transaction_creates_command_record(core, ws_table):
    """Happy path: transact_write_items succeeds and the pending record is written."""
    item = core._reserve_and_create_command(USER, 'cmd-happy', 'linkedin:search', {'q': 'x'})

    assert item['commandId'] == 'cmd-happy'
    assert item['status'] == 'pending'
    stored = ws_table.get_item(Key={'PK': 'COMMAND#cmd-happy', 'SK': '#METADATA'}).get('Item')
    assert stored is not None
    assert stored['status'] == 'pending'


def test_rate_limit_enforced_across_calls(core, ws_table):
    """The real atomic path: with the cap set to 2, the third create is rate-limited."""
    _seed_agent(ws_table)
    core.RATE_LIMIT_MAX = 2
    with patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True):
        assert core.create_command(USER, 'linkedin:search', {})[0] == 200
        assert core.create_command(USER, 'linkedin:search', {})[0] == 200
        status, body = core.create_command(USER, 'linkedin:search', {})
    assert status == 429
    assert body['code'] == 'RATE_LIMITED'


# --- Command vocabulary: reject an unknown type before anything is persisted ---
def _routes_declared_in(path) -> frozenset:
    """Parse the ``ROUTES`` map keys out of a ``commandRouter.ts``.

    The client router is the authority on what is *routable*: a command type it
    has no entry for is written, rate-limited, dispatched over WebSocket and
    then answered with UNKNOWN_COMMAND. Parsing it here makes this test the
    drift check until Phase 7 wires ``scripts/check-command-vocabulary.py``.
    """
    import re

    src = path.read_text()
    body = src.split('export const ROUTES', 1)[1]
    # The map ends at the first column-0 '};'.
    block = body.split('\n};', 1)[0]
    return frozenset(re.findall(r"^  '([^']+)': \{", block, re.MULTILINE))


# The community edition's router declares only the five browser routes:
# `client/src/domains/github` is in `.sync/config.json` exclude_paths, and the
# two Comment Concierge routes are pro-only. This test file syncs VERBATIM to
# the community repo, so an equality assertion against the local router would
# be red there. The containment below is the direction that is load-bearing in
# both editions — a type the client can route must never be rejected by the
# core — and the second assertion still pins the pro tree exactly, because the
# difference there is empty.
_EDITION_OPTIONAL_TYPES = frozenset(
    {
        'github:connect',
        'github:disconnect',
        'github:poll-metrics',
        'github:get-status',
        'linkedin:post-comment',
        'linkedin:scrape-feed',
    }
)


def test_known_command_types_covers_every_routable_client_command():
    from conftest import REPO_ROOT

    routes = _routes_declared_in(REPO_ROOT / 'client' / 'src' / 'transport' / 'commandRouter.ts')
    assert routes, 'failed to parse any ROUTES key — the parser drifted from the router'

    from shared_services.command_dispatch_core import KNOWN_COMMAND_TYPES

    missing = routes - KNOWN_COMMAND_TYPES
    assert not missing, f'the client can route types the core would reject with 400: {sorted(missing)}'
    extra = KNOWN_COMMAND_TYPES - routes
    assert extra <= _EDITION_OPTIONAL_TYPES, (
        f'KNOWN_COMMAND_TYPES carries types no client edition routes: {sorted(extra - _EDITION_OPTIONAL_TYPES)}'
    )


def test_unknown_command_type_returns_400_and_persists_nothing(core, ws_table):
    """A typo must be REJECTED, not written. Returned (not raised): a validation
    rejection is definitively not-sent, so it belongs on the clean-outcome
    channel (Phase-0 §5.1). Raising would tell the agent gate to treat a typo as
    an ambiguous send and refuse to release quota."""
    _seed_agent(ws_table)
    before = ws_table.scan()['Items']

    with patch('shared_services.websocket_service.WebSocketService.send_to_connection') as mock_send:
        status, body = core.create_command(USER, 'linkedin:typo', {})

    assert status == 400
    assert body['code'] == 'UNKNOWN_COMMAND_TYPE'
    assert 'linkedin:typo' in body['error']
    mock_send.assert_not_called()
    # Zero writes: no COMMAND# record and no rate-limit slot burned.
    after = ws_table.scan()['Items']
    assert after == before
    assert not [i for i in after if i['PK'].startswith('COMMAND#')]
    assert not [i for i in after if i['SK'].startswith('RATELIMIT#')]


def test_unknown_command_type_is_rejected_before_the_agent_lookup(core, ws_table):
    """The check is first, so a bad type cannot burn a lookup, a rate-limit slot,
    or — on a misconfigured deploy — reach the raise channel the gate reads as
    maybe-sent."""
    with patch(
        'shared_services.websocket_service.WebSocketService.get_user_connections'
    ) as mock_lookup:
        status, _ = core.create_command(USER, 'linkedin:typo', {})
    assert status == 400
    mock_lookup.assert_not_called()


def test_every_known_command_type_still_dispatches(core, ws_table):
    _seed_agent(ws_table)
    core.RATE_LIMIT_MAX = 100
    with patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True):
        for command_type in sorted(core.KNOWN_COMMAND_TYPES):
            status, body = core.create_command(USER, command_type, {})
            assert status == 200, f'{command_type} was rejected'
            assert body['status'] == 'dispatched'
