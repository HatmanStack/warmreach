"""Unit tests for the LinkedIn action gate (manual li-actions metering)."""
import json
import os
from unittest.mock import MagicMock

import pytest

from conftest import load_lambda_module


@pytest.fixture(autouse=True)
def _env_vars():
    """The gate reads COMMAND_DISPATCH_FUNCTION_NAME at import."""
    os.environ['COMMAND_DISPATCH_FUNCTION_NAME'] = 'warmreach-command-dispatch-test'
    yield


@pytest.fixture
def gate_module():
    """Load the gate with quota service + command-dispatch invoker mocked."""
    module = load_lambda_module('linkedin-action-gate')
    module._quota_service = MagicMock()
    module.lambda_client = MagicMock()
    return module


def _event(command_type='linkedin:add-connection', payload=None, sub='user-1'):
    ctx = {'http': {'method': 'POST'}}
    if sub:
        ctx['authorizer'] = {'jwt': {'claims': {'sub': sub}}}
    return {
        'httpMethod': 'POST',
        'rawPath': '/linkedin-actions',
        'requestContext': ctx,
        'body': json.dumps({'type': command_type, 'payload': payload or {}}),
    }


def _dispatch_returns(gate_module, status_code=200, body=None):
    """Make the mocked command-dispatch invoke return a Lambda-proxy response."""
    envelope = {'statusCode': status_code, 'body': json.dumps(body or {'commandId': 'cmd-1', 'status': 'dispatched'})}
    payload_reader = MagicMock()
    payload_reader.read.return_value = json.dumps(envelope).encode('utf-8')
    gate_module.lambda_client.invoke.return_value = {'Payload': payload_reader}


def test_gates_and_forwards_on_success(gate_module, lambda_context):
    _dispatch_returns(gate_module, 200, {'commandId': 'cmd-1', 'status': 'dispatched'})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 200
    gate_module._quota_service.reserve_li_action_usage.assert_called_once()
    gate_module.lambda_client.invoke.assert_called_once()
    gate_module._quota_service.release_li_action_usage.assert_not_called()
    assert json.loads(resp['body'])['commandId'] == 'cmd-1'


def test_over_quota_returns_429_without_dispatch(gate_module, lambda_context):
    from errors.exceptions import QuotaExceededError

    gate_module._quota_service.reserve_li_action_usage.side_effect = QuotaExceededError(
        'cap', operation='linkedin:add-connection'
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 429
    gate_module.lambda_client.invoke.assert_not_called()


def test_reserve_infra_failure_fails_closed_503(gate_module, lambda_context):
    from botocore.exceptions import ClientError

    gate_module._quota_service.reserve_li_action_usage.side_effect = ClientError(
        {'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem'
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 503
    gate_module.lambda_client.invoke.assert_not_called()


def test_unsupported_type_400_no_reserve(gate_module, lambda_context):
    # A read op (search) must never consume the li-actions bucket.
    resp = gate_module.lambda_handler(_event(command_type='linkedin:search'), lambda_context)
    assert resp['statusCode'] == 400
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.lambda_client.invoke.assert_not_called()


def test_dispatch_failure_refunds_quota(gate_module, lambda_context):
    # command-dispatch returns 409 (no agent) -> refund and pass 409 through.
    _dispatch_returns(gate_module, 409, {'error': 'No agent connected'})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 409
    gate_module._quota_service.release_li_action_usage.assert_called_once()


def test_unauthenticated_returns_401(gate_module, lambda_context):
    resp = gate_module.lambda_handler(_event(sub=None), lambda_context)
    assert resp['statusCode'] == 401
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()


def test_non_object_json_body_returns_400(gate_module, lambda_context):
    # A valid-JSON scalar/array must not crash the handler (AttributeError -> 500).
    event = _event()
    event['body'] = json.dumps(['not', 'an', 'object'])
    resp = gate_module.lambda_handler(event, lambda_context)
    assert resp['statusCode'] == 400
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.lambda_client.invoke.assert_not_called()


def test_options_preflight_returns_204(gate_module, lambda_context):
    event = _event()
    event['httpMethod'] = 'OPTIONS'
    event['requestContext']['http']['method'] = 'OPTIONS'
    resp = gate_module.lambda_handler(event, lambda_context)
    assert resp['statusCode'] == 204
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.lambda_client.invoke.assert_not_called()


def test_command_dispatch_rate_limited_passes_through_and_refunds(gate_module, lambda_context):
    # command-dispatch's own 10/min rate limit (429) -> refund + pass 429 through.
    _dispatch_returns(gate_module, 429, {'error': 'Too many commands', 'code': 'RATE_LIMITED'})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 429
    gate_module._quota_service.release_li_action_usage.assert_called_once()
