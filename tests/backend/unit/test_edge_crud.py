"""Tests for edge-crud Lambda function."""
import json
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def edge_crud_module():
    """Load the edge-crud Lambda module within a mock AWS context."""
    from moto import mock_aws
    with mock_aws():
        return load_lambda_module('edge-crud')


@pytest.fixture
def mock_edge_service(edge_crud_module):
    """Replace module-level edge data service with a mock."""
    mock_svc = MagicMock()
    orig = edge_crud_module._edge_data_service
    edge_crud_module._edge_data_service = mock_svc
    yield mock_svc
    edge_crud_module._edge_data_service = orig


def _make_event(operation, body=None, user_id='test-user'):
    payload = {'operation': operation}
    if body:
        payload.update(body)
    return {
        'body': json.dumps(payload),
        'requestContext': {'authorizer': {'claims': {'sub': user_id}}},
    }


class TestEdgeCrudRouting:
    """Tests for edge-crud operation routing."""

    def test_options_returns_204(self, lambda_context, edge_crud_module):
        event = {'requestContext': {'http': {'method': 'OPTIONS'}}}
        resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 204

    def test_unauthorized_returns_401(self, lambda_context, edge_crud_module):
        event = {'body': json.dumps({'operation': 'check_exists'})}
        resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 401

    def test_unsupported_operation_returns_400(self, lambda_context, edge_crud_module):
        event = _make_event('nonexistent_op')
        resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400

    def test_get_connections_by_status(self, lambda_context, edge_crud_module, mock_edge_service):
        mock_edge_service.get_connections_by_status.return_value = {'connections': [], 'count': 0}
        event = _make_event('get_connections_by_status')
        resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_upsert_status_requires_profile_id(self, lambda_context, edge_crud_module, mock_edge_service):
        event = _make_event('upsert_status')
        resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400
        assert 'profileId' in json.loads(resp['body'])['error']

    def test_upsert_status_success(self, lambda_context, edge_crud_module, mock_edge_service):
        mock_edge_service.upsert_status.return_value = {'success': True, 'profileId': 'abc'}
        event = _make_event('upsert_status', {'profileId': 'test-profile', 'updates': {'status': 'ally'}})
        with patch.object(edge_crud_module, 'write_activity'):
            resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_add_message_success(self, lambda_context, edge_crud_module, mock_edge_service):
        mock_edge_service.add_message.return_value = {'success': True}
        event = _make_event('add_message', {'profileId': 'p1', 'updates': {'message': 'hi'}})
        with patch.object(edge_crud_module, 'write_activity'):
            resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_check_exists(self, lambda_context, edge_crud_module, mock_edge_service):
        mock_edge_service.check_exists.return_value = {'exists': True}
        event = _make_event('check_exists', {'profileId': 'p1'})
        resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_add_note(self, lambda_context, edge_crud_module, mock_edge_service):
        mock_edge_service.add_note.return_value = {'success': True}
        event = _make_event('add_note', {'profileId': 'p1', 'content': 'Note text'})
        with patch.object(edge_crud_module, 'write_activity'):
            resp = edge_crud_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_get_activity_timeline(self, lambda_context, edge_crud_module):
        mock_activity = MagicMock()
        mock_activity.get_activity_timeline.return_value = {'events': [], 'count': 0}
        orig = edge_crud_module._activity_service
        edge_crud_module._activity_service = mock_activity
        try:
            event = _make_event('get_activity_timeline')
            resp = edge_crud_module.lambda_handler(event, lambda_context)
        finally:
            edge_crud_module._activity_service = orig
        assert resp['statusCode'] == 200


class TestHandlerCount:
    """Verify the routing table has the expected number of handlers."""

    def test_has_10_handlers(self, edge_crud_module):
        assert len(edge_crud_module.HANDLERS) == 10
