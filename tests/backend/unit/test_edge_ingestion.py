"""Unit tests for EdgeIngestionService."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from shared_services.edge_ingestion_service import EdgeIngestionService


class TestTriggerRagstackIngestion:
    """Tests for EdgeIngestionService.trigger_ragstack_ingestion."""

    def test_calls_ragstack_proxy_when_configured(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = [
            # _get_ingest_state returns None (not recently ingested)
            {},
            # _get_profile_metadata returns profile data
            {'Item': {'PK': 'PROFILE#abc', 'name': 'Test User'}},
        ]
        mock_ingestion_svc = MagicMock()
        mock_ingestion_svc.ingest_profile.return_value = {
            'status': 'uploaded',
            'documentId': 'doc-123',
        }

        service = EdgeIngestionService(
            table=mock_table,
            ragstack_endpoint='https://ragstack.example.com',
            ragstack_api_key='key-123',
            ragstack_client=MagicMock(),
            ingestion_service=mock_ingestion_svc,
        )

        with patch('shared_services.edge_ingestion_service.generate_profile_markdown', return_value='# Profile'):
            result = service.trigger_ragstack_ingestion('abc', 'user-1')

        assert result['success'] is True
        mock_ingestion_svc.ingest_profile.assert_called_once()

    def test_noop_when_ragstack_not_configured(self):
        mock_table = MagicMock()
        service = EdgeIngestionService(table=mock_table)

        result = service.trigger_ragstack_ingestion('abc', 'user-1')

        assert result['success'] is False
        assert 'not configured' in result['error']

    def test_noop_when_no_client_or_ingestion(self):
        mock_table = MagicMock()
        service = EdgeIngestionService(
            table=mock_table,
            ragstack_endpoint='https://ragstack.example.com',
            ragstack_api_key='key-123',
        )

        result = service.trigger_ragstack_ingestion('abc', 'user-1')

        assert result['success'] is False
        assert 'not injected' in result['error']

    def test_skips_when_recently_ingested(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'ingested_at': datetime.now(UTC).isoformat(),
                'document_id': 'existing-doc',
            }
        }
        mock_ingestion_svc = MagicMock()

        service = EdgeIngestionService(
            table=mock_table,
            ragstack_endpoint='https://ragstack.example.com',
            ragstack_api_key='key-123',
            ragstack_client=MagicMock(),
            ingestion_service=mock_ingestion_svc,
        )

        result = service.trigger_ragstack_ingestion('abc', 'user-1')

        assert result['success'] is True
        assert result['status'] == 'already_ingested'
        mock_ingestion_svc.ingest_profile.assert_not_called()


class TestUpdateIngestionFlag:
    """Tests for EdgeIngestionService.update_ingestion_flag."""

    def test_updates_dynamodb_item(self):
        mock_table = MagicMock()
        service = EdgeIngestionService(table=mock_table)

        service.update_ingestion_flag('user-1', 'profile-abc', '2024-01-01T00:00:00')

        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args[1]
        assert call_kwargs['Key'] == {'PK': 'USER#user-1', 'SK': 'PROFILE#profile-abc'}
        assert call_kwargs['ExpressionAttributeValues'][':ingested'] is True

    def test_includes_document_id_when_provided(self):
        mock_table = MagicMock()
        service = EdgeIngestionService(table=mock_table)

        service.update_ingestion_flag('user-1', 'profile-abc', '2024-01-01T00:00:00', document_id='doc-999')

        call_kwargs = mock_table.update_item.call_args[1]
        assert ':doc_id' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':doc_id'] == 'doc-999'

    def test_suppresses_exceptions(self):
        mock_table = MagicMock()
        mock_table.update_item.side_effect = Exception('DynamoDB error')
        service = EdgeIngestionService(table=mock_table)

        # Should not raise
        service.update_ingestion_flag('user-1', 'profile-abc', '2024-01-01T00:00:00')
