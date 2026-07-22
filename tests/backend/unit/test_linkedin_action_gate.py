"""Unit tests for the LinkedIn action gate (manual li-actions metering).

The gate now creates the command by calling ``command_dispatch_core.create_command``
IN-PROCESS (no Lambda hop), so these tests patch that function on the gate module
and re-assert the send-path invariants: reserve-before-create, fail-closed metering
(429 over quota / 503 on metering-infra failure), refund on a non-200 create (a
clean, definitely-not-sent outcome) but NOT on a raised create (maybe-sent — a real
send may already have dispatched), and the non-object-body guard.
"""
import json
from unittest.mock import MagicMock

import pytest

from conftest import load_lambda_module


@pytest.fixture
def gate_module():
    """Load the gate with the quota service and the in-process create_command mocked."""
    module = load_lambda_module('linkedin-action-gate')
    module._quota_service = MagicMock()
    module.create_command = MagicMock(return_value=(200, {'commandId': 'cmd-1', 'status': 'dispatched'}))
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
    """Make the mocked in-process create_command return a (status, body) tuple."""
    gate_module.create_command.return_value = (status_code, body or {'commandId': 'cmd-1', 'status': 'dispatched'})


def test_gates_and_forwards_on_success(gate_module, lambda_context):
    _dispatch_returns(gate_module, 200, {'commandId': 'cmd-1', 'status': 'dispatched'})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 200
    gate_module._quota_service.reserve_li_action_usage.assert_called_once()
    gate_module.create_command.assert_called_once()
    gate_module._quota_service.release_li_action_usage.assert_not_called()
    assert json.loads(resp['body'])['commandId'] == 'cmd-1'


def test_reserve_precedes_create(gate_module, lambda_context):
    """Quota is reserved BEFORE the command is created (claim-before-send)."""
    order = []
    gate_module._quota_service.reserve_li_action_usage.side_effect = lambda *a, **k: order.append('reserve')
    gate_module.create_command.side_effect = lambda *a, **k: (order.append('create'), (200, {'commandId': 'c'}))[1]
    gate_module.lambda_handler(_event(), lambda_context)
    assert order == ['reserve', 'create']


def test_create_passes_type_and_payload(gate_module, lambda_context):
    """The gate forwards the validated command type and payload to the core."""
    gate_module.lambda_handler(_event(command_type='linkedin:send-message', payload={'x': 1}), lambda_context)
    args = gate_module.create_command.call_args[0]
    assert args[0] == 'user-1'
    assert args[1] == 'linkedin:send-message'
    assert args[2] == {'x': 1}


def test_over_quota_returns_429_without_dispatch(gate_module, lambda_context):
    from errors.exceptions import QuotaExceededError

    gate_module._quota_service.reserve_li_action_usage.side_effect = QuotaExceededError(
        'cap', operation='linkedin:add-connection'
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 429
    gate_module.create_command.assert_not_called()


def test_reserve_infra_failure_fails_closed_503(gate_module, lambda_context):
    from botocore.exceptions import ClientError

    gate_module._quota_service.reserve_li_action_usage.side_effect = ClientError(
        {'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem'
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 503
    gate_module.create_command.assert_not_called()


def test_unsupported_type_400_no_reserve(gate_module, lambda_context):
    # A read op (search) must never consume the li-actions bucket.
    resp = gate_module.lambda_handler(_event(command_type='linkedin:search'), lambda_context)
    assert resp['statusCode'] == 400
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.create_command.assert_not_called()


def test_dispatch_failure_refunds_quota(gate_module, lambda_context):
    # create_command returns 409 (no agent) -> refund and pass 409 through.
    _dispatch_returns(gate_module, 409, {'error': 'No agent connected'})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 409
    gate_module._quota_service.release_li_action_usage.assert_called_once()


def test_create_command_raises_keeps_reservation_and_503(gate_module, lambda_context):
    """A RAISED create_command is now exclusively an at/after-dispatch (maybe-sent)
    outcome: the core turns its only clean pre-dispatch failure (the agent-connection
    lookup) into a RETURNED 503. A real LinkedIn send may already have dispatched, so
    the gate must NOT refund — it keeps the reservation and fails closed with 503."""
    gate_module.create_command.side_effect = RuntimeError('post-send boom')
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 503
    gate_module._quota_service.release_li_action_usage.assert_not_called()


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
    gate_module.create_command.assert_not_called()


def test_options_preflight_returns_204(gate_module, lambda_context):
    event = _event()
    event['httpMethod'] = 'OPTIONS'
    event['requestContext']['http']['method'] = 'OPTIONS'
    resp = gate_module.lambda_handler(event, lambda_context)
    assert resp['statusCode'] == 204
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.create_command.assert_not_called()


def test_command_dispatch_rate_limited_passes_through_and_refunds(gate_module, lambda_context):
    # The core's own 10/min rate limit (429) -> refund + pass 429 through.
    _dispatch_returns(gate_module, 429, {'error': 'Too many commands', 'code': 'RATE_LIMITED'})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp['statusCode'] == 429
    gate_module._quota_service.release_li_action_usage.assert_called_once()
