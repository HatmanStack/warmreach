"""Tests for RAGStack Client"""
import json
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests
import requests_mock

# Add shared python layer to path
SHARED_PYTHON_PATH = Path(__file__).parent.parent.parent.parent / 'backend' / 'lambdas' / 'shared' / 'python'
sys.path.insert(0, str(SHARED_PYTHON_PATH))

import shared_services.ragstack_client as _ragstack_mod
from shared_services.ragstack_client import (
    RAGStackAuthError,
    RAGStackClient,
    RAGStackError,
    RAGStackGraphQLError,
    RAGStackNetworkError,
)


@pytest.fixture
def ragstack_client():
    """Create a RAGStack client instance"""
    return RAGStackClient(
        endpoint="https://api.example.com/graphql",
        api_key="test-api-key",
        max_retries=2,
        retry_delay=0.1,  # Fast retries for tests
    )


class TestRAGStackClientInit:
    """Tests for client initialization"""

    def test_init_with_valid_params(self):
        """Test successful initialization"""
        client = RAGStackClient(
            endpoint="https://api.example.com/graphql",
            api_key="test-key",
        )
        assert client.endpoint == "https://api.example.com/graphql"
        assert client.api_key == "test-key"

    def test_init_without_endpoint(self):
        """Test initialization without endpoint raises error"""
        with pytest.raises(ValueError, match="endpoint is required"):
            RAGStackClient(endpoint="", api_key="test-key")

    def test_init_without_api_key(self):
        """Test initialization without API key raises error"""
        with pytest.raises(ValueError, match="api_key is required"):
            RAGStackClient(endpoint="https://api.example.com", api_key="")


class TestSearch:
    """Tests for search functionality"""

    def test_search_returns_results(self, ragstack_client):
        """Test successful search with results"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={
                    "data": {
                        "searchKnowledgeBase": {
                            "results": [
                                {"content": "Profile content", "source": "profile_abc123", "score": 0.95},
                                {"content": "Another profile", "source": "profile_def456", "score": 0.85},
                            ]
                        }
                    }
                },
            )

            results = ragstack_client.search("software engineer")

            assert len(results) == 2
            assert results[0]["source"] == "profile_abc123"
            assert results[0]["score"] == 0.95
            assert results[1]["source"] == "profile_def456"

    def test_search_with_no_results(self, ragstack_client):
        """Test search with empty results"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={"data": {"searchKnowledgeBase": {"results": []}}},
            )

            results = ragstack_client.search("nonexistent query")

            assert len(results) == 0

    def test_search_with_max_results(self, ragstack_client):
        """Test search with custom max_results"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {"searchKnowledgeBase": {"results": []}}})

            ragstack_client.search("test query", max_results=50)

            # Verify the request was made with correct variables
            request_body = json.loads(m.last_request.text)
            assert request_body["variables"]["maxResults"] == 50

    def test_search_without_query(self, ragstack_client):
        """Test search without query raises error"""
        with pytest.raises(ValueError, match="query is required"):
            ragstack_client.search("")

    def test_search_with_long_query(self, ragstack_client):
        """Test search with very long query"""
        long_query = "a" * 2000
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {"searchKnowledgeBase": {"results": []}}})
            ragstack_client.search(long_query)
            assert m.called

    def test_search_with_zero_max_results(self, ragstack_client):
        """Test search with max_results=0"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {"searchKnowledgeBase": {"results": []}}})
            ragstack_client.search("test", max_results=0)
            request_body = json.loads(m.last_request.text)
            assert request_body["variables"]["maxResults"] == 0

    def test_search_with_one_max_results(self, ragstack_client):
        """Test search with max_results=1"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {"searchKnowledgeBase": {"results": []}}})
            ragstack_client.search("test", max_results=1)
            request_body = json.loads(m.last_request.text)
            assert request_body["variables"]["maxResults"] == 1

    def test_search_with_missing_fields_in_results(self, ragstack_client):
        """Test search handling missing fields in results"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={
                    "data": {
                        "searchKnowledgeBase": {
                            "results": [
                                {"content": "Missing source/score"},
                                {"source": "Missing content/score"},
                            ]
                        }
                    }
                },
            )
            results = ragstack_client.search("test")
            assert len(results) == 2
            assert results[0]["content"] == "Missing source/score"
            assert results[0]["source"] == ""  # Default value
            assert results[0]["score"] == 0.0  # Default value
            assert results[1]["source"] == "Missing content/score"
            assert results[1]["content"] == ""  # Default value


class TestCreateUploadUrl:
    """Tests for upload URL creation"""

    def test_create_upload_url_success(self, ragstack_client):
        """Test successful upload URL creation"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={
                    "data": {
                        "createUploadUrl": {
                            "uploadUrl": "https://s3.example.com/upload?signature=xxx",
                            "documentId": "doc123",
                            "fields": {"key": "value"},
                        }
                    }
                },
            )

            result = ragstack_client.create_upload_url("profile_abc.md")

            assert result["uploadUrl"] == "https://s3.example.com/upload?signature=xxx"
            assert result["documentId"] == "doc123"
            assert result["fields"] == {"key": "value"}

    def test_create_upload_url_without_filename(self, ragstack_client):
        """Test upload URL creation without filename raises error"""
        with pytest.raises(ValueError, match="filename is required"):
            ragstack_client.create_upload_url("")

    def test_create_upload_url_empty_response(self, ragstack_client):
        """Test handling of empty upload URL response"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {}})

            with pytest.raises(RAGStackGraphQLError, match="No upload URL returned"):
                ragstack_client.create_upload_url("test.md")


class TestGetDocumentStatus:
    """Tests for document status checking"""

    def test_get_document_status_indexed(self, ragstack_client):
        """Test getting status of indexed document"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={
                    "data": {
                        "getDocumentStatus": {
                            "status": "indexed",
                            "documentId": "doc123",
                            "error": None,
                        }
                    }
                },
            )

            result = ragstack_client.get_document_status("doc123")

            assert result["status"] == "indexed"
            assert result["documentId"] == "doc123"
            assert result["error"] is None

    def test_get_document_status_pending(self, ragstack_client):
        """Test getting status of pending document"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={
                    "data": {
                        "getDocumentStatus": {
                            "status": "pending",
                            "documentId": "doc123",
                            "error": None,
                        }
                    }
                },
            )

            result = ragstack_client.get_document_status("doc123")

            assert result["status"] == "pending"

    def test_get_document_status_failed(self, ragstack_client):
        """Test getting status of failed document"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={
                    "data": {
                        "getDocumentStatus": {
                            "status": "failed",
                            "documentId": "doc123",
                            "error": "Indexing failed: invalid format",
                        }
                    }
                },
            )

            result = ragstack_client.get_document_status("doc123")

            assert result["status"] == "failed"
            assert "invalid format" in result["error"]

    def test_get_document_status_without_id(self, ragstack_client):
        """Test status check without document ID raises error"""
        with pytest.raises(ValueError, match="document_id is required"):
            ragstack_client.get_document_status("")


class TestErrorHandling:
    """Tests for error handling"""

    def test_graphql_error_response(self, ragstack_client):
        """Test handling of GraphQL errors"""
        with requests_mock.Mocker() as m:
            m.post(
                ragstack_client.endpoint,
                json={"errors": [{"message": "Invalid query syntax"}]},
            )

            with pytest.raises(RAGStackGraphQLError, match="Invalid query syntax"):
                ragstack_client.search("test")

    def test_auth_error_401(self, ragstack_client):
        """Test handling of 401 unauthorized"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, status_code=401)

            with pytest.raises(RAGStackAuthError, match="Invalid API key"):
                ragstack_client.search("test")

    def test_auth_error_403(self, ragstack_client):
        """Test handling of 403 forbidden"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, status_code=403)

            with pytest.raises(RAGStackAuthError, match="Access denied"):
                ragstack_client.search("test")

    def test_network_timeout_with_retry(self, ragstack_client):
        """Test timeout handling with retry"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, exc=requests.exceptions.Timeout)

            with pytest.raises(RAGStackNetworkError, match="timeout"):
                ragstack_client.search("test")

            # Should have retried (max_retries=2)
            assert m.call_count == 2

    def test_post_called_with_connect_and_read_timeout(self, ragstack_client):
        """Fail-fast contract: session.post must pass an explicit (connect, read) timeout tuple."""
        with patch.object(ragstack_client.session, "post", wraps=ragstack_client.session.post) as spy_post:
            with requests_mock.Mocker() as m:
                m.post(
                    ragstack_client.endpoint,
                    json={"data": {"searchKnowledgeBase": {"results": []}}},
                )
                ragstack_client.search("test")

            assert spy_post.call_count == 1
            kwargs = spy_post.call_args.kwargs
            timeout = kwargs.get("timeout")
            assert isinstance(timeout, tuple), f"expected (connect, read) tuple, got {timeout!r}"
            assert len(timeout) == 2
            connect, read = timeout
            assert 0 < connect <= 10
            assert 0 < read <= 60

    def test_connection_error_with_retry(self, ragstack_client):
        """Test connection error handling with retry"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, exc=requests.exceptions.ConnectionError)

            with pytest.raises(RAGStackNetworkError, match="Connection error"):
                ragstack_client.search("test")

            assert m.call_count == 2

    def test_invalid_json_response(self, ragstack_client):
        """Test handling of invalid JSON response"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, text="not valid json")

            # JSON decode errors may be wrapped in different exception types
            with pytest.raises((RAGStackError, RAGStackNetworkError)):
                ragstack_client.search("test")


class TestCircuitBreakerStoreSelection:
    """Tests that RAGStackClient uses CachedDynamoDBStore in production."""

    def test_uses_cached_dynamodb_store_when_table_available(self):
        """When a DynamoDB table is available, the circuit breaker store should be CachedDynamoDBStore."""
        mock_table = Mock()
        mock_table.get_item.return_value = {'Item': {}}

        with patch.object(_ragstack_mod, '_get_cb_table', return_value=mock_table):
            client = RAGStackClient(
                endpoint="https://api.example.com/graphql",
                api_key="test-key",
            )
            # Use class name to avoid identity mismatch from module reloads in test suite
            assert type(client._circuit_breaker.store).__name__ == 'CachedDynamoDBStore'

    def test_uses_inmemory_store_when_no_table(self):
        """When no DynamoDB table is configured, falls back to InMemoryStore."""
        with patch.object(_ragstack_mod, '_get_cb_table', return_value=None):
            client = RAGStackClient(
                endpoint="https://api.example.com/graphql",
                api_key="test-key",
            )
            # Use class name to avoid identity mismatch from module reloads in test suite
            assert type(client._circuit_breaker.store).__name__ == 'InMemoryStore'


class TestApiKeyHeader:
    """Tests for API key authentication"""

    def test_api_key_in_headers(self, ragstack_client):
        """Test that API key is included in request headers"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {"searchKnowledgeBase": {"results": []}}})

            ragstack_client.search("test")

            assert m.last_request.headers["x-api-key"] == "test-api-key"

    def test_content_type_header(self, ragstack_client):
        """Test that Content-Type header is set correctly"""
        with requests_mock.Mocker() as m:
            m.post(ragstack_client.endpoint, json={"data": {"searchKnowledgeBase": {"results": []}}})

            ragstack_client.search("test")

            assert m.last_request.headers["Content-Type"] == "application/json"
