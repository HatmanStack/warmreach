"""Tests for RAGStack integration (shared client + edge-processing handler)"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add shared python path
SHARED_PATH = Path(__file__).parent.parent.parent.parent / 'backend' / 'lambdas' / 'shared' / 'python'
sys.path.insert(0, str(SHARED_PATH))

from shared_services.ragstack_client import RAGStackClient, RAGStackError, RAGStackAuthError


class TestRAGStackClient:
    """Tests for RAGStack GraphQL client"""

    def test_init_requires_endpoint(self):
        with pytest.raises(ValueError, match="endpoint is required"):
            RAGStackClient('', 'key')

    def test_init_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            RAGStackClient('https://api.example.com', '')

    @patch('shared_services.ragstack_client.requests.Session')
    def test_search_success(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'data': {
                'searchKnowledgeBase': {
                    'results': [
                        {'content': 'test content', 'source': 'profile_123', 'score': 0.9}
                    ]
                }
            }
        }
        mock_session.post.return_value = mock_response

        client = RAGStackClient('https://api.example.com/graphql', 'test-key')
        results = client.search('software engineer', max_results=10)

        assert len(results) == 1
        assert results[0]['source'] == 'profile_123'
        assert results[0]['score'] == 0.9

    @patch('shared_services.ragstack_client.requests.Session')
    def test_search_empty_results(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'data': {'searchKnowledgeBase': {'results': []}}
        }
        mock_session.post.return_value = mock_response

        client = RAGStackClient('https://api.example.com/graphql', 'test-key')
        results = client.search('nonexistent query')
        assert results == []

    @patch('shared_services.ragstack_client.requests.Session')
    def test_search_requires_query(self, mock_session_cls):
        client = RAGStackClient('https://api.example.com/graphql', 'test-key')
        with pytest.raises(ValueError, match="query is required"):
            client.search('')

    @patch('shared_services.ragstack_client.requests.Session')
    def test_auth_error_raises(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_session.post.return_value = mock_response

        client = RAGStackClient('https://api.example.com/graphql', 'bad-key')
        with pytest.raises(RAGStackAuthError):
            client.search('test')

    @patch('shared_services.ragstack_client.requests.Session')
    def test_create_upload_url(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'data': {
                'createUploadUrl': {
                    'uploadUrl': 'https://s3.example.com/upload',
                    'documentId': 'doc-123',
                    'fields': {}
                }
            }
        }
        mock_session.post.return_value = mock_response

        client = RAGStackClient('https://api.example.com/graphql', 'test-key')
        result = client.create_upload_url('profile_abc.md')

        assert result['uploadUrl'] == 'https://s3.example.com/upload'
        assert result['documentId'] == 'doc-123'


@pytest.fixture
def edge_module():
    """Load edge-processing module with RAGStack configured"""
    from conftest import load_lambda_module
    module = load_lambda_module('edge-processing')
    return module


def _make_ragstack_proxy_svc(ragstack_client=None, ingestion_service=None, table=None):
    """Helper to create a RAGStackProxyService with mocked dependencies."""
    from shared_services.ragstack_proxy_service import RAGStackProxyService
    return RAGStackProxyService(
        ragstack_client=ragstack_client,
        ingestion_service=ingestion_service,
        table=table or MagicMock(),
    )


class TestSearchOperation:
    """Tests for search operation through edge-processing handler"""

    def test_search_requires_query(self, edge_module):
        mock_client = MagicMock()
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack({'operation': 'search'}, 'user-123')
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 400

    def test_search_success(self, edge_module):
        mock_client = MagicMock()
        mock_client.search.return_value = [
            {'content': 'test', 'source': 'profile_1', 'score': 0.8}
        ]
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack(
                {'operation': 'search', 'query': 'engineer', 'maxResults': 10},
                'user-123'
            )
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['totalResults'] == 1

    def test_search_ragstack_not_configured(self, edge_module):
        svc = _make_ragstack_proxy_svc()  # No ragstack_client
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack(
                {'operation': 'search', 'query': 'test'},
                'user-123'
            )
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 503


class TestIngestOperation:
    """Tests for ingest operation"""

    def test_ingest_requires_profile_id(self, edge_module):
        mock_client = MagicMock()
        mock_ingestion = MagicMock()
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client, ingestion_service=mock_ingestion)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack(
                {'operation': 'ingest', 'markdownContent': '# Profile'},
                'user-123'
            )
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 400

    def test_ingest_requires_content(self, edge_module):
        mock_client = MagicMock()
        mock_ingestion = MagicMock()
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client, ingestion_service=mock_ingestion)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack(
                {'operation': 'ingest', 'profileId': 'profile-123'},
                'user-123'
            )
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 400

    def test_ingest_success(self, edge_module):
        mock_client = MagicMock()
        mock_ingestion = MagicMock()
        mock_ingestion.ingest_profile.return_value = {
            'status': 'uploaded', 'documentId': 'doc-123',
            'profileId': 'profile-123', 'error': None
        }
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # Not recently ingested
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client, ingestion_service=mock_ingestion, table=mock_table)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack({
                'operation': 'ingest',
                'profileId': 'profile-123',
                'markdownContent': '# John Doe\nSoftware Engineer',
                'metadata': {'source': 'test'}
            }, 'user-123')
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['status'] == 'uploaded'

    def test_ingest_includes_user_id_in_metadata(self, edge_module):
        """Verify user_id is added to metadata via service"""
        mock_client = MagicMock()
        mock_ingestion = MagicMock()
        mock_ingestion.ingest_profile.return_value = {'status': 'uploaded', 'documentId': 'doc-1', 'error': None}
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # Not recently ingested
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client, ingestion_service=mock_ingestion, table=mock_table)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            edge_module._handle_ragstack({
                'operation': 'ingest',
                'profileId': 'p-1',
                'markdownContent': '# Test',
            }, 'my-user-id')
        finally:
            edge_module._ragstack_proxy_service = orig
        call_args = mock_ingestion.ingest_profile.call_args[0]
        assert call_args[2]['user_id'] == 'my-user-id'


class TestStatusOperation:
    """Tests for status operation"""

    def test_status_requires_document_id(self, edge_module):
        mock_client = MagicMock()
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack({'operation': 'status'}, 'user-123')
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 400

    def test_status_success(self, edge_module):
        mock_client = MagicMock()
        mock_client.get_document_status.return_value = {
            'status': 'indexed', 'documentId': 'doc-123', 'error': None
        }
        svc = _make_ragstack_proxy_svc(ragstack_client=mock_client)
        orig = edge_module._ragstack_proxy_service
        edge_module._ragstack_proxy_service = svc
        try:
            result = edge_module._handle_ragstack(
                {'operation': 'status', 'documentId': 'doc-123'},
                'user-123'
            )
        finally:
            edge_module._ragstack_proxy_service = orig
        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['status'] == 'indexed'


class TestDevMode:
    """Tests for dev mode behavior"""

    def test_dev_mode_allows_unauthenticated(self, edge_module):
        """Dev mode should allow unauthenticated access"""
        with patch.dict(os.environ, {'DEV_MODE': 'true'}):
            user_id = edge_module._get_user_id({'requestContext': {}})
            assert user_id == 'test-user-development'

    def test_dev_mode_blocked_in_production(self, edge_module):
        """Production should reject unauthenticated access"""
        with patch.dict(os.environ, {'DEV_MODE': 'false'}):
            user_id = edge_module._get_user_id({'requestContext': {}})
            assert user_id is None
