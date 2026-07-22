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
import os
import sys
from unittest.mock import patch

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
    with patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True), \
         patch.object(core, 'write_activity') as mock_wa:
        status, _ = core.create_command(USER, 'linkedin:search', {'query': 'x'})

    assert status == 200
    mock_wa.assert_called_once()
    assert mock_wa.call_args[0][2] == 'command_dispatched'
    assert mock_wa.call_args[1]['metadata']['commandType'] == 'linkedin:search'


def test_create_command_post_send_exception_propagates(core, ws_table):
    """A post-send failure (status update / activity write) must PROPAGATE, not be
    swallowed — it is the ambiguous-outcome signal the agent gate relies on (a real
    send may already have happened, so callers must not revert)."""
    _seed_agent(ws_table)
    with patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True), \
         patch.object(core, 'write_activity', side_effect=RuntimeError('post-send boom')):
        with pytest.raises(RuntimeError, match='post-send boom'):
            core.create_command(USER, 'linkedin:search', {})


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
