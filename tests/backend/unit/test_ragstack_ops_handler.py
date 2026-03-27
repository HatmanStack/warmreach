"""Tests for ragstack-ops Lambda handler."""

import json
from unittest.mock import MagicMock

import pytest

from conftest import load_lambda_module


@pytest.fixture
def ragstack_ops_module():
    """Load the ragstack-ops Lambda module."""
    return load_lambda_module('ragstack-ops')


@pytest.fixture
def mock_ragstack_services(ragstack_ops_module):
    """Replace module-level quota service with mock."""
    mock_quota = MagicMock()
    mock_quota.report_usage.return_value = None
    orig_quota = ragstack_ops_module._quota_service
    ragstack_ops_module._quota_service = mock_quota
    yield {'quota': mock_quota}
    ragstack_ops_module._quota_service = orig_quota


def _make_event(body_dict):
    return {
        'body': json.dumps(body_dict),
        'rawPath': '/ragstack',
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }


def test_ragstack_search_success(lambda_context, ragstack_ops_module, mock_ragstack_services):
    """search returns 200 with results."""
    event = _make_event({'operation': 'search', 'query': 'test query'})
    mock_proxy = MagicMock()
    mock_proxy.is_configured.return_value = True
    mock_proxy.ragstack_search.return_value = {'results': [], 'count': 0}
    orig = ragstack_ops_module._ragstack_proxy_service
    ragstack_ops_module._ragstack_proxy_service = mock_proxy
    try:
        response = ragstack_ops_module.lambda_handler(event, lambda_context)
    finally:
        ragstack_ops_module._ragstack_proxy_service = orig
    assert response['statusCode'] == 200


def test_ragstack_ingest_requires_profile_id(lambda_context, ragstack_ops_module, mock_ragstack_services):
    """ingest without profileId returns 400."""
    event = _make_event({'operation': 'ingest', 'markdownContent': 'test'})
    mock_proxy = MagicMock()
    mock_proxy.is_configured.return_value = True
    orig = ragstack_ops_module._ragstack_proxy_service
    ragstack_ops_module._ragstack_proxy_service = mock_proxy
    try:
        response = ragstack_ops_module.lambda_handler(event, lambda_context)
    finally:
        ragstack_ops_module._ragstack_proxy_service = orig
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'profileId' in body['error']


def test_ragstack_not_configured_returns_503(lambda_context, ragstack_ops_module, mock_ragstack_services):
    """Returns 503 when RAGStack is not configured."""
    event = _make_event({'operation': 'search', 'query': 'test'})
    mock_proxy = MagicMock()
    mock_proxy.is_configured.return_value = False
    orig = ragstack_ops_module._ragstack_proxy_service
    ragstack_ops_module._ragstack_proxy_service = mock_proxy
    try:
        response = ragstack_ops_module.lambda_handler(event, lambda_context)
    finally:
        ragstack_ops_module._ragstack_proxy_service = orig
    assert response['statusCode'] == 503


def test_ragstack_status_requires_document_id(lambda_context, ragstack_ops_module, mock_ragstack_services):
    """status without documentId returns 400."""
    event = _make_event({'operation': 'status'})
    mock_proxy = MagicMock()
    mock_proxy.is_configured.return_value = True
    orig = ragstack_ops_module._ragstack_proxy_service
    ragstack_ops_module._ragstack_proxy_service = mock_proxy
    try:
        response = ragstack_ops_module.lambda_handler(event, lambda_context)
    finally:
        ragstack_ops_module._ragstack_proxy_service = orig
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'documentId' in body['error']


def test_ragstack_unsupported_operation(lambda_context, ragstack_ops_module, mock_ragstack_services):
    """Unsupported ragstack operation returns 400."""
    event = _make_event({'operation': 'unknown'})
    mock_proxy = MagicMock()
    mock_proxy.is_configured.return_value = True
    orig = ragstack_ops_module._ragstack_proxy_service
    ragstack_ops_module._ragstack_proxy_service = mock_proxy
    try:
        response = ragstack_ops_module.lambda_handler(event, lambda_context)
    finally:
        ragstack_ops_module._ragstack_proxy_service = orig
    assert response['statusCode'] == 400


def test_unauthorized_returns_401(lambda_context, ragstack_ops_module):
    """Unauthenticated requests return 401."""
    event = {'body': json.dumps({'operation': 'search'}), 'rawPath': '/ragstack'}
    response = ragstack_ops_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 401


def test_options_returns_204(lambda_context, ragstack_ops_module):
    """OPTIONS returns 204."""
    event = {'requestContext': {'http': {'method': 'OPTIONS'}}}
    response = ragstack_ops_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 204
