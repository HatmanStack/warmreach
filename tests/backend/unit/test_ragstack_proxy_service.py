"""Unit tests for RAGStackProxyService - RAGStack proxy operations."""
import base64
from unittest.mock import MagicMock, patch

import pytest

from shared_services.ragstack_proxy_service import RAGStackProxyService


class TestRAGStackProxyServiceInit:
    """Tests for initialization."""

    def test_accepts_ragstack_client_and_ingestion_service(self):
        mock_client = MagicMock()
        mock_ingestion = MagicMock()
        service = RAGStackProxyService(
            ragstack_client=mock_client,
            ingestion_service=mock_ingestion,
        )
        assert service.ragstack_client == mock_client
        assert service.ingestion_service == mock_ingestion


class TestRagstackSearch:
    """Tests for ragstack_search."""

    def test_calls_client_with_query_and_max_results(self):
        mock_client = MagicMock()
        mock_client.search.return_value = [{'id': 'p1'}]
        service = RAGStackProxyService(ragstack_client=mock_client)

        result = service.ragstack_search('test query', 50)

        mock_client.search.assert_called_once_with('test query', 50)
        assert result['results'] == [{'id': 'p1'}]
        assert result['totalResults'] == 1

    def test_raises_when_not_configured(self):
        service = RAGStackProxyService(ragstack_client=None)

        with pytest.raises(Exception, match='RAGStack not configured'):
            service.ragstack_search('query')


class TestRagstackIngest:
    """Tests for ragstack_ingest."""

    def test_calls_ingestion_service(self):
        mock_ingestion = MagicMock()
        mock_ingestion.ingest_profile.return_value = {
            'status': 'uploaded', 'documentId': 'doc-1'
        }
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No recent ingestion
        service = RAGStackProxyService(
            ingestion_service=mock_ingestion,
            table=mock_table,
        )

        result = service.ragstack_ingest('profile-1', '# Content', {}, 'user-1')

        mock_ingestion.ingest_profile.assert_called_once()
        assert result['status'] == 'uploaded'

    def test_raises_when_not_configured(self):
        service = RAGStackProxyService(ingestion_service=None)

        with pytest.raises(Exception, match='RAGStack not configured'):
            service.ragstack_ingest('p', 'content', {}, 'user')

    def test_skips_recently_ingested(self):
        from datetime import UTC, datetime, timedelta

        mock_ingestion = MagicMock()
        mock_table = MagicMock()
        recent = (datetime.now(UTC) - timedelta(days=5)).isoformat()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'PROFILE#profile-1',
                'SK': '#INGEST_STATE',
                'ingested_at': recent,
            }
        }
        service = RAGStackProxyService(
            ingestion_service=mock_ingestion,
            table=mock_table,
        )

        result = service.ragstack_ingest('profile-1', '# Content', {}, 'user-1')

        assert result['status'] == 'skipped'
        assert result['reason'] == 'recently_ingested'
        mock_ingestion.ingest_profile.assert_not_called()


class TestRagstackStatus:
    """Tests for ragstack_status."""

    def test_calls_client_for_status(self):
        mock_client = MagicMock()
        mock_client.get_document_status.return_value = {'status': 'indexed'}
        service = RAGStackProxyService(ragstack_client=mock_client)

        result = service.ragstack_status('doc-123')

        mock_client.get_document_status.assert_called_once_with('doc-123')
        assert result['status'] == 'indexed'

    def test_raises_when_not_configured(self):
        service = RAGStackProxyService(ragstack_client=None)

        with pytest.raises(Exception, match='RAGStack not configured'):
            service.ragstack_status('doc-123')


class TestErrorHandling:
    """Tests for error scenarios."""

    def test_search_propagates_client_error(self):
        mock_client = MagicMock()
        mock_client.search.side_effect = RuntimeError('Connection failed')
        service = RAGStackProxyService(ragstack_client=mock_client)

        with pytest.raises(RuntimeError, match='Connection failed'):
            service.ragstack_search('query')


class TestRagstackIngestEncoding:
    """Tests for profile_id encoding in ragstack_ingest."""

    def test_raw_profile_id_is_base64_encoded(self):
        """A raw LinkedIn URL should be base64-encoded before dedup check."""
        mock_ingestion = MagicMock()
        mock_ingestion.ingest_profile.return_value = {
            'status': 'uploaded', 'documentId': 'doc-1'
        }
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No recent ingestion
        service = RAGStackProxyService(
            ingestion_service=mock_ingestion,
            table=mock_table,
        )

        raw_url = 'https://linkedin.com/in/jane-doe'
        result = service.ragstack_ingest(raw_url, '# Content', {}, 'user-1')

        assert result['status'] == 'uploaded'
        # Verify dedup check used the encoded profile_id
        expected_b64 = base64.urlsafe_b64encode(raw_url.encode()).decode()
        get_item_key = mock_table.get_item.call_args[1]['Key']
        assert get_item_key['PK'] == f'PROFILE#{expected_b64}'
        # Verify ingest_profile also receives the b64-encoded ID (not the raw URL)
        assert mock_ingestion.ingest_profile.call_args[0][0] == expected_b64
