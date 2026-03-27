"""Tests for edge-crud Lambda handler."""

import json
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def edge_crud_module():
    """Load the edge-crud Lambda module."""
    return load_lambda_module('edge-crud')


@pytest.fixture
def mock_edge_crud_services(edge_crud_module):
    """Replace module-level quota and feature flag services with mocks."""
    mock_quota = MagicMock()
    mock_quota.report_usage.return_value = None
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {
            'opportunity_tracker': True,
        },
        'quotas': {},
        'rateLimits': {},
    }

    orig_quota = edge_crud_module._quota_service
    orig_ff = edge_crud_module._feature_flag_service
    edge_crud_module._quota_service = mock_quota
    edge_crud_module._feature_flag_service = mock_ff
    yield {'quota': mock_quota, 'feature_flags': mock_ff}
    edge_crud_module._quota_service = orig_quota
    edge_crud_module._feature_flag_service = orig_ff


def _make_event(operation, **extra):
    body = {'operation': operation}
    body.update(extra)
    return {
        'body': json.dumps(body),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }


def test_options_returns_204(lambda_context, edge_crud_module):
    """OPTIONS returns 204."""
    event = {
        'requestContext': {'http': {'method': 'OPTIONS'}},
    }
    response = edge_crud_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 204


def test_unauthorized_returns_401(lambda_context, edge_crud_module):
    """Unauthenticated requests return 401."""
    event = {'body': json.dumps({'operation': 'check_exists'})}
    response = edge_crud_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 401


def test_unsupported_operation(lambda_context, edge_crud_module, mock_edge_crud_services):
    """Unknown operation returns 400."""
    event = _make_event('nonexistent_operation')
    response = edge_crud_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400


def test_upsert_status_success(lambda_context, edge_crud_module, mock_edge_crud_services):
    """upsert_status returns 200."""
    event = _make_event('upsert_status', profileId='test-profile', updates={'status': 'ally'})
    mock_svc = MagicMock()
    mock_svc.upsert_status.return_value = {'success': True, 'profileId': 'p1', 'status': 'ally'}
    orig = edge_crud_module._edge_data_service
    edge_crud_module._edge_data_service = mock_svc
    try:
        with patch.object(edge_crud_module, 'write_activity'):
            response = edge_crud_module.lambda_handler(event, lambda_context)
    finally:
        edge_crud_module._edge_data_service = orig
    assert response['statusCode'] == 200


def test_get_connections_by_status(lambda_context, edge_crud_module, mock_edge_crud_services):
    """get_connections_by_status returns connections."""
    event = _make_event('get_connections_by_status', updates={'status': 'connected'})
    mock_svc = MagicMock()
    mock_svc.get_connections_by_status.return_value = {'connections': [{'id': 'p1'}], 'count': 1}
    orig = edge_crud_module._edge_data_service
    edge_crud_module._edge_data_service = mock_svc
    try:
        response = edge_crud_module.lambda_handler(event, lambda_context)
    finally:
        edge_crud_module._edge_data_service = orig
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['count'] == 1


def test_add_message_requires_profile_id(lambda_context, edge_crud_module, mock_edge_crud_services):
    """add_message without profileId returns 400."""
    event = _make_event('add_message', updates={'message': 'hi'})
    response = edge_crud_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400


def test_add_note_success(lambda_context, edge_crud_module, mock_edge_crud_services):
    """add_note calls EdgeDataService.add_note."""
    event = _make_event('add_note', profileId='test-profile', content='Great connection')
    mock_svc = MagicMock()
    mock_svc.add_note.return_value = {'success': True, 'noteId': 'n1', 'profileId': 'p1'}
    orig = edge_crud_module._edge_data_service
    edge_crud_module._edge_data_service = mock_svc
    try:
        with patch.object(edge_crud_module, 'write_activity'):
            response = edge_crud_module.lambda_handler(event, lambda_context)
    finally:
        edge_crud_module._edge_data_service = orig
    assert response['statusCode'] == 200
    mock_svc.add_note.assert_called_once_with('test-user', 'test-profile', 'Great connection')


def test_get_activity_timeline(lambda_context, edge_crud_module, mock_edge_crud_services):
    """get_activity_timeline calls ActivityService."""
    event = _make_event('get_activity_timeline', eventType='message_sent', limit=25)
    mock_svc = MagicMock()
    mock_svc.get_activity_timeline.return_value = {
        'success': True, 'activities': [], 'nextCursor': None, 'count': 0,
    }
    orig = edge_crud_module._activity_service
    edge_crud_module._activity_service = mock_svc
    try:
        response = edge_crud_module.lambda_handler(event, lambda_context)
    finally:
        edge_crud_module._activity_service = orig
    assert response['statusCode'] == 200


def test_tag_connection_success(lambda_context, edge_crud_module, mock_edge_crud_services):
    """tag_connection returns 200."""
    event = _make_event('tag_connection', profileId='pid1', opportunityId='opp-1')
    mock_svc = MagicMock()
    mock_svc.tag_connection_to_opportunity.return_value = {
        'success': True, 'profileId': 'pid1', 'opportunityId': 'opp-1', 'stage': 'identified',
    }
    orig = edge_crud_module._edge_data_service
    edge_crud_module._edge_data_service = mock_svc
    try:
        response = edge_crud_module.lambda_handler(event, lambda_context)
    finally:
        edge_crud_module._edge_data_service = orig
    assert response['statusCode'] == 200


def test_handler_has_required_operations(edge_crud_module):
    """HANDLERS dict contains all required CRUD operations."""
    required = {
        'get_connections_by_status', 'upsert_status', 'add_message', 'update_messages',
        'get_messages', 'check_exists', 'add_note', 'update_note', 'delete_note',
        'get_activity_timeline', 'detect_lifecycle_events', 'tag_connection',
        'untag_connection', 'update_connection_stage', 'get_opportunity_connections',
    }
    assert required.issubset(set(edge_crud_module.HANDLERS.keys()))


def test_detect_lifecycle_events_success(lambda_context, edge_crud_module, mock_edge_crud_services):
    """detect_lifecycle_events returns 200."""
    event = _make_event('detect_lifecycle_events', profileId='pid1', newMetadata={'currentTitle': 'New'})
    mock_svc = MagicMock()
    mock_svc.detect_and_record_changes.return_value = {
        'success': True, 'changesDetected': True, 'changes': {},
    }
    orig = edge_crud_module._lifecycle_event_service
    edge_crud_module._lifecycle_event_service = mock_svc
    try:
        response = edge_crud_module.lambda_handler(event, lambda_context)
    finally:
        edge_crud_module._lifecycle_event_service = orig
    assert response['statusCode'] == 200
