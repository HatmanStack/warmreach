"""Unit tests for EdgeStatusService."""
import base64
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared_services.edge_status_service import EdgeStatusService
from errors.exceptions import ExternalServiceError


def _encode(profile_id: str) -> str:
    return base64.urlsafe_b64encode(profile_id.encode()).decode()


class TestEdgeStatusServiceUpsert:
    """Tests for EdgeStatusService.upsert_status."""

    def _make_service(self, ingestion_service=None):
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_client = MagicMock()
        service = EdgeStatusService(
            table=mock_table,
            ingestion_service=ingestion_service,
            dynamodb_client=mock_client,
        )
        return service, mock_table, mock_client

    def test_creates_edge_with_new_status(self):
        service, mock_table, mock_client = self._make_service()

        result = service.upsert_status(
            user_id='test-user',
            profile_id='https://linkedin.com/in/john',
            status='possible',
        )

        assert result['success'] is True
        assert result['status'] == 'possible'
        mock_client.transact_write_items.assert_called_once()

    def test_updates_existing_edge_status(self):
        service, mock_table, mock_client = self._make_service()

        result = service.upsert_status(
            user_id='test-user',
            profile_id='test-profile',
            status='ally',
        )

        assert result['success'] is True
        assert result['status'] == 'ally'

    def test_triggers_ingestion_for_ingestion_status(self):
        mock_ingestion = MagicMock()
        mock_ingestion.trigger_ragstack_ingestion.return_value = {
            'success': True,
            'status': 'uploaded',
            'documentId': 'doc-123',
        }
        service, mock_table, mock_client = self._make_service(
            ingestion_service=mock_ingestion,
        )

        result = service.upsert_status('test-user', 'profile', 'ally')

        assert result['success'] is True
        assert result['ragstack_ingested'] is True
        mock_ingestion.trigger_ragstack_ingestion.assert_called_once()

    def test_skips_ingestion_when_no_ingestion_service(self):
        service, mock_table, mock_client = self._make_service(ingestion_service=None)

        result = service.upsert_status('test-user', 'profile', 'ally')

        assert result['success'] is True
        assert result['ragstack_ingested'] is False

    def test_dynamo_error_raises_external_service_error(self):
        service, mock_table, mock_client = self._make_service()
        mock_client.transact_write_items.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'TransactWriteItems',
        )

        with pytest.raises(ExternalServiceError):
            service.upsert_status('test-user', 'profile', 'ally')

    def test_returns_b64_encoded_profile_id(self):
        service, mock_table, mock_client = self._make_service()

        result = service.upsert_status(
            user_id='test-user',
            profile_id='https://linkedin.com/in/john',
            status='possible',
        )

        decoded = base64.urlsafe_b64decode(result['profileId']).decode()
        assert decoded == 'https://linkedin.com/in/john'

    def test_ingestion_failure_sets_ragstack_error(self):
        mock_ingestion = MagicMock()
        mock_ingestion.trigger_ragstack_ingestion.return_value = {
            'success': False,
            'error': 'RAGStack not configured',
        }
        service, mock_table, mock_client = self._make_service(
            ingestion_service=mock_ingestion,
        )

        result = service.upsert_status('test-user', 'profile', 'outgoing')

        assert result['ragstack_ingested'] is False
        assert result['ragstack_error'] == 'RAGStack not configured'
