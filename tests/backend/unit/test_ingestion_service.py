"""Tests for Profile Ingestion Service"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import pytest
import requests

# Add shared python layer to path
SHARED_PYTHON_PATH = Path(__file__).parent.parent.parent.parent / 'backend' / 'lambdas' / 'shared' / 'python'
sys.path.insert(0, str(SHARED_PYTHON_PATH))

from shared_services.ingestion_service import IngestionError, IngestionService, UploadError
from shared_services.ragstack_client import RAGStackClient, RAGStackError


@pytest.fixture
def mock_ragstack_client():
    """Create a mock RAGStack client"""
    client = MagicMock(spec=RAGStackClient)
    client.create_upload_url.return_value = {
        "uploadUrl": "https://s3.example.com/upload?signature=xxx",
        "documentId": "doc123",
        "fields": {},
    }
    client.get_document_status.return_value = {
        "status": "indexed",
        "documentId": "doc123",
        "error": None,
    }
    return client


@pytest.fixture
def ingestion_service(mock_ragstack_client):
    """Create an ingestion service instance"""
    return IngestionService(
        ragstack_client=mock_ragstack_client,
        max_upload_retries=2,
        upload_retry_delay=0.01,  # Fast retries for tests
    )


class TestIngestionServiceInit:
    """Tests for service initialization"""

    def test_init_with_client(self, mock_ragstack_client):
        """Test successful initialization"""
        service = IngestionService(ragstack_client=mock_ragstack_client)
        assert service.client == mock_ragstack_client


class TestIngestProfile:
    """Tests for profile ingestion"""

    @patch('shared_services.ingestion_service.requests.put')
    def test_ingest_profile_uploads_markdown(self, mock_put, ingestion_service, mock_ragstack_client):
        """Test successful profile ingestion returns submitted status."""
        mock_put.return_value = Mock(status_code=200)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test Profile\n\nContent here",
        )

        assert result["status"] == "submitted"
        assert result["documentId"] == "doc123"
        assert result["profileId"] == "profile_abc"
        assert result["error"] is None

        # Verify upload URL was requested
        mock_ragstack_client.create_upload_url.assert_called_once_with("profile_abc.md")

        # Verify content was uploaded
        mock_put.assert_called_once()

    @patch('shared_services.ingestion_service.requests.put')
    def test_ingest_profile_with_metadata(self, mock_put, ingestion_service):
        """Test ingestion with metadata"""
        mock_put.return_value = Mock(status_code=200)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test Profile",
            metadata={"user_id": "user123"},
        )

        assert result["status"] == "submitted"

        # Verify metadata was included in uploaded content
        call_args = mock_put.call_args
        uploaded_data = call_args.kwargs["data"].decode("utf-8")
        assert "user_id: user123" in uploaded_data
        assert "profile_id: profile_abc" in uploaded_data
        assert "source: linkedin_profile" in uploaded_data

    @patch('shared_services.ingestion_service.requests.put')
    def test_ingest_profile_returns_submitted(self, mock_put, ingestion_service, mock_ragstack_client):
        """Test ingestion returns submitted status immediately (fire-and-forget)."""
        mock_put.return_value = Mock(status_code=200)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test Profile",
        )

        assert result["status"] == "submitted"
        assert result["documentId"] == "doc123"
        mock_ragstack_client.get_document_status.assert_not_called()

    def test_ingest_profile_without_profile_id(self, ingestion_service):
        """Test ingestion without profile_id raises error"""
        with pytest.raises(ValueError, match="profile_id is required"):
            ingestion_service.ingest_profile(
                profile_id="",
                markdown_content="# Test",
            )

    def test_ingest_profile_without_content(self, ingestion_service):
        """Test ingestion without content raises error"""
        with pytest.raises(ValueError, match="markdown_content is required"):
            ingestion_service.ingest_profile(
                profile_id="profile_abc",
                markdown_content="",
            )

    @patch('shared_services.ingestion_service.requests.put')
    def test_ingest_profile_s3_upload_failure(self, mock_put, ingestion_service):
        """Test handling of S3 upload failure"""
        mock_put.return_value = Mock(status_code=500, text="Internal Server Error")

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "failed"
        assert "500" in result["error"]
        # Should have retried
        assert mock_put.call_count == 2

    def test_ingest_profile_ragstack_error(self, ingestion_service, mock_ragstack_client):
        """Test handling of RAGStack API error"""
        mock_ragstack_client.create_upload_url.side_effect = RAGStackError("API error")

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "failed"
        assert "API error" in result["error"]

    @patch('shared_services.ingestion_service.requests.put')
    def test_ingest_profile_idempotent(self, mock_put, ingestion_service, mock_ragstack_client):
        """Test that repeated ingestion uses same filename"""
        mock_put.return_value = Mock(status_code=200)

        # Ingest same profile twice
        ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test v1",
        )
        ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test v2",
        )

        # Both should use same filename
        calls = mock_ragstack_client.create_upload_url.call_args_list
        assert calls[0][0][0] == "profile_abc.md"
        assert calls[1][0][0] == "profile_abc.md"


class TestS3Upload:
    """Tests for S3 upload functionality"""

    @patch('shared_services.ingestion_service.requests.put')
    def test_upload_success_200(self, mock_put, ingestion_service):
        """Test successful PUT upload with 200 response"""
        mock_put.return_value = Mock(status_code=200)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "submitted"

    @patch('shared_services.ingestion_service.requests.put')
    def test_upload_success_204(self, mock_put, ingestion_service):
        """Test successful PUT upload with 204 response"""
        mock_put.return_value = Mock(status_code=204)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "submitted"

    @patch('shared_services.ingestion_service.requests.post')
    def test_upload_multipart_with_fields(self, mock_post, ingestion_service, mock_ragstack_client):
        """Test multipart upload when fields are provided"""
        mock_ragstack_client.create_upload_url.return_value = {
            "uploadUrl": "https://s3.example.com/upload",
            "documentId": "doc123",
            "fields": {"key": "value", "policy": "xxx"},
        }
        mock_post.return_value = Mock(status_code=204)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "submitted"
        mock_post.assert_called_once()

    @patch('shared_services.ingestion_service.requests.put')
    def test_upload_retry_on_timeout(self, mock_put, ingestion_service):
        """Test upload retries on timeout"""
        mock_put.side_effect = [
            requests.exceptions.Timeout,
            Mock(status_code=200),
        ]

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "submitted"
        assert mock_put.call_count == 2

    @patch('shared_services.ingestion_service.requests.put')
    def test_upload_retry_on_connection_error(self, mock_put, ingestion_service):
        """Test upload retries on connection error"""
        mock_put.side_effect = [
            requests.exceptions.ConnectionError,
            Mock(status_code=200),
        ]

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "submitted"


class TestFireAndForgetIngestion:
    """Tests for fire-and-forget ingestion (no blocking poll)."""

    @patch('shared_services.ingestion_service.requests.put')
    def test_ingest_returns_submitted_status(self, mock_put, ingestion_service, mock_ragstack_client):
        """Ingestion returns status:'submitted' with documentId immediately."""
        mock_put.return_value = Mock(status_code=200)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test Profile",
        )

        assert result["status"] == "submitted"
        assert result["documentId"] == "doc123"
        assert result["error"] is None
        # get_document_status should NOT be called (no polling)
        mock_ragstack_client.get_document_status.assert_not_called()

    @patch('shared_services.ingestion_service.requests.put')
    @patch('shared_services.ingestion_service.time.sleep')
    def test_ingest_does_not_block(self, mock_sleep, mock_put, ingestion_service):
        """Verify time.sleep is not called during ingest (only upload retry uses it)."""
        mock_put.return_value = Mock(status_code=200)

        ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        # time.sleep should not be called when upload succeeds on first attempt
        mock_sleep.assert_not_called()

    @patch('shared_services.ingestion_service.requests.put')
    def test_wait_for_indexing_param_ignored(self, mock_put, ingestion_service, mock_ragstack_client):
        """wait_for_indexing parameter is removed; ingestion always returns immediately."""
        mock_put.return_value = Mock(status_code=200)

        result = ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
        )

        assert result["status"] == "submitted"
        mock_ragstack_client.get_document_status.assert_not_called()


class TestMetadataPreparation:
    """Tests for content metadata preparation"""

    @patch('shared_services.ingestion_service.requests.put')
    def test_frontmatter_format(self, mock_put, ingestion_service):
        """Test YAML frontmatter format"""
        mock_put.return_value = Mock(status_code=200)

        ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test Profile",
            metadata={"user_id": "user123"},
        )

        uploaded_data = mock_put.call_args.kwargs["data"].decode("utf-8")
        assert uploaded_data.startswith("---")
        assert "---\n\n#" in uploaded_data  # Frontmatter ends with --- followed by blank line and content
        assert "# Test Profile" in uploaded_data

    @patch('shared_services.ingestion_service.requests.put')
    def test_metadata_with_list_values(self, mock_put, ingestion_service):
        """Test metadata with list values (YAML format)"""
        mock_put.return_value = Mock(status_code=200)

        ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test",
            metadata={"tags": ["tag1", "tag2"]},
        )

        uploaded_data = mock_put.call_args.kwargs["data"].decode("utf-8")
        # yaml.safe_dump formats lists as YAML list syntax
        assert "- tag1" in uploaded_data
        assert "- tag2" in uploaded_data

    @patch('shared_services.ingestion_service.requests.put')
    def test_no_frontmatter_without_metadata(self, mock_put, ingestion_service):
        """Test no frontmatter when metadata is None"""
        mock_put.return_value = Mock(status_code=200)

        ingestion_service.ingest_profile(
            profile_id="profile_abc",
            markdown_content="# Test Profile",
            metadata=None,
        )

        uploaded_data = mock_put.call_args.kwargs["data"].decode("utf-8")
        assert uploaded_data == "# Test Profile"
        assert "---" not in uploaded_data
