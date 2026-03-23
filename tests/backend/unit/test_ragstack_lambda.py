"""Tests for ragstack Lambda function."""
import json
from unittest.mock import MagicMock

import pytest

from conftest import load_lambda_module


@pytest.fixture
def ragstack_module():
    """Load the ragstack Lambda module within a mock AWS context."""
    from moto import mock_aws
    with mock_aws():
        return load_lambda_module('ragstack')


@pytest.fixture
def mock_proxy(ragstack_module):
    """Replace module-level ragstack proxy service with a mock."""
    mock_svc = MagicMock()
    mock_svc.is_configured.return_value = True
    orig = ragstack_module._ragstack_proxy_service
    ragstack_module._ragstack_proxy_service = mock_svc
    yield mock_svc
    ragstack_module._ragstack_proxy_service = orig


def _make_event(operation, body=None, user_id='test-user'):
    payload = {'operation': operation}
    if body:
        payload.update(body)
    return {
        'body': json.dumps(payload),
        'requestContext': {'authorizer': {'claims': {'sub': user_id}}},
    }


class TestRagstackRouting:
    """Tests for ragstack operation routing."""

    def test_options_returns_204(self, lambda_context, ragstack_module):
        event = {'requestContext': {'http': {'method': 'OPTIONS'}}}
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 204

    def test_unauthorized_returns_401(self, lambda_context, ragstack_module):
        event = {'body': json.dumps({'operation': 'search'})}
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 401

    def test_not_configured_returns_503(self, lambda_context, ragstack_module):
        mock_svc = MagicMock()
        mock_svc.is_configured.return_value = False
        orig = ragstack_module._ragstack_proxy_service
        ragstack_module._ragstack_proxy_service = mock_svc
        try:
            event = _make_event('search', {'query': 'test'})
            resp = ragstack_module.lambda_handler(event, lambda_context)
        finally:
            ragstack_module._ragstack_proxy_service = orig
        assert resp['statusCode'] == 503

    def test_search_requires_query(self, lambda_context, ragstack_module, mock_proxy):
        event = _make_event('search')
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400

    def test_search_success(self, lambda_context, ragstack_module, mock_proxy):
        mock_proxy.ragstack_search.return_value = {'results': []}
        event = _make_event('search', {'query': 'test query'})
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_ingest_requires_profile_id(self, lambda_context, ragstack_module, mock_proxy):
        event = _make_event('ingest', {'markdownContent': '# Test'})
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400

    def test_ingest_success(self, lambda_context, ragstack_module, mock_proxy):
        mock_proxy.ragstack_ingest.return_value = {'success': True, 'documentId': 'doc1'}
        event = _make_event('ingest', {'profileId': 'p1', 'markdownContent': '# Test'})
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_status_requires_document_id(self, lambda_context, ragstack_module, mock_proxy):
        event = _make_event('status')
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400

    def test_status_success(self, lambda_context, ragstack_module, mock_proxy):
        mock_proxy.ragstack_status.return_value = {'status': 'indexed'}
        event = _make_event('status', {'documentId': 'doc1'})
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 200

    def test_unsupported_operation(self, lambda_context, ragstack_module, mock_proxy):
        event = _make_event('nonexistent')
        resp = ragstack_module.lambda_handler(event, lambda_context)
        assert resp['statusCode'] == 400
