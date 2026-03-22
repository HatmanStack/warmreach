"""Unit tests for EdgeDataService - edge CRUD operations."""
import base64
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared_services.base_service import BaseService

# We'll import EdgeDataService after creating it
# For now, the path is set up via conftest.py's sys.path
from shared_services.edge_data_service import EdgeDataService

from errors.exceptions import ExternalServiceError, ValidationError


class TestEdgeDataServiceInit:
    """Tests for EdgeDataService initialization."""

    def test_inherits_base_service(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)
        assert isinstance(service, BaseService)

    def test_initializes_with_table(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)
        assert service.table == mock_table

    def test_initializes_with_optional_deps(self):
        mock_table = MagicMock()
        mock_ragstack = MagicMock()
        mock_ingestion = MagicMock()
        service = EdgeDataService(
            table=mock_table,
            ragstack_client=mock_ragstack,
            ingestion_service=mock_ingestion,
        )
        assert service.ragstack_client == mock_ragstack
        assert service.ingestion_service == mock_ingestion


class TestUpsertStatus:
    """Tests for upsert_status operation."""

    def test_creates_forward_and_reverse_edges(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        result = service.upsert_status(
            user_id='test-user',
            profile_id='https://linkedin.com/in/john',
            status='possible',
        )

        assert result['success'] is True
        mock_table.put_item.assert_called_once()
        mock_table.update_item.assert_called_once()

    def test_returns_b64_profile_id(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        result = service.upsert_status(
            user_id='test-user',
            profile_id='https://linkedin.com/in/john',
            status='possible',
        )

        decoded = base64.urlsafe_b64decode(result['profileId']).decode()
        assert decoded == 'https://linkedin.com/in/john'

    def test_updates_existing_edge(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        result = service.upsert_status(
            user_id='test-user',
            profile_id='test-profile',
            status='ally',
        )

        assert result['success'] is True
        assert result['status'] == 'ally'

    def test_dynamo_error_raises_external_service_error(self):
        mock_table = MagicMock()
        mock_table.put_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'PutItem',
        )
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.upsert_status('test-user', 'profile', 'ally')

    def test_triggers_ingestion_for_ally_status(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'name': 'John'}}
        service = EdgeDataService(table=mock_table)

        with patch.object(service, '_trigger_ragstack_ingestion') as mock_ingest:
            mock_ingest.return_value = {'success': True, 'status': 'uploaded'}
            result = service.upsert_status('test-user', 'profile', 'ally')

        assert result['success'] is True
        mock_ingest.assert_called_once()


class TestAddMessage:
    """Tests for add_message operation."""

    def test_appends_message(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'messages': []}}
        service = EdgeDataService(table=mock_table)

        result = service.add_message('test-user', 'https://linkedin.com/in/test', 'Hello!', 'outbound')

        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    def test_add_message_encodes_profile_id(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'messages': []}}
        service = EdgeDataService(table=mock_table)

        result = service.add_message('test-user', 'https://linkedin.com/in/test', 'Hello!', 'outbound')

        expected_b64 = base64.urlsafe_b64encode(b'https://linkedin.com/in/test').decode()
        key = mock_table.update_item.call_args[1]['Key']
        assert key['SK'] == f'PROFILE#{expected_b64}'

    def test_empty_message_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_message('test-user', 'https://linkedin.com/in/test', '', 'outbound')


class TestCheckExists:
    """Tests for check_exists operation."""

    def test_returns_true_when_exists(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'status': 'ally', 'addedAt': '2024-01-01'}
        }
        service = EdgeDataService(table=mock_table)

        result = service.check_exists('test-user', 'test-profile')

        assert result['exists'] is True
        assert result['edge_data']['status'] == 'ally'

    def test_returns_false_when_not_exists(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = EdgeDataService(table=mock_table)

        result = service.check_exists('test-user', 'test-profile')

        assert result['exists'] is False
        assert result['edge_data'] is None


class TestGetConnectionsByStatus:
    """Tests for get_connections_by_status operation."""

    def test_returns_formatted_connections(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdA==',
                    'status': 'ally',
                    'addedAt': '2024-01-01',
                    'messages': [],
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {'name': 'John Doe', 'headline': 'Engineer'}
        }
        service = EdgeDataService(table=mock_table)

        result = service.get_connections_by_status('test-user', 'ally')

        assert result['success'] is True
        assert len(result['connections']) == 1


class TestQueryAllUserEdges:
    """Tests for _query_all_user_edges with pagination."""

    def test_single_page(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [{'PK': 'USER#u1', 'SK': 'PROFILE#p1'}]
        }
        service = EdgeDataService(table=mock_table)

        edges = service._query_all_user_edges('u1')

        assert len(edges) == 1
        mock_table.query.assert_called_once()

    def test_multiple_pages(self):
        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {
                'Items': [{'PK': 'USER#u1', 'SK': 'PROFILE#p1'}],
                'LastEvaluatedKey': {'PK': 'USER#u1', 'SK': 'PROFILE#p1'},
            },
            {
                'Items': [{'PK': 'USER#u1', 'SK': 'PROFILE#p2'}],
            },
        ]
        service = EdgeDataService(table=mock_table)

        edges = service._query_all_user_edges('u1')

        assert len(edges) == 2
        assert mock_table.query.call_count == 2


class TestUpsertStatusRollback:
    """Tests for rollback path in upsert_status when reverse edge write fails."""

    def test_forward_edge_deleted_on_reverse_edge_failure(self):
        """When the reverse edge put_item raises, the forward edge should be rolled back."""
        mock_table = MagicMock()
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'Reverse edge failed'}},
            'UpdateItem',
        )
        service = EdgeDataService(table=mock_table)

        profile_id = 'https://linkedin.com/in/rollback-test'
        profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()

        with pytest.raises(ExternalServiceError):
            service.upsert_status('test-user', profile_id, 'ally')

        # Forward edge should have been written then deleted
        mock_table.put_item.assert_called_once()
        mock_table.delete_item.assert_called_once_with(
            Key={'PK': 'USER#test-user', 'SK': f'PROFILE#{profile_id_b64}'}
        )


class TestBatchGetProfileMetadata:
    """Tests for batch_get_profile_metadata using moto (real DDB deserialization)."""

    def test_returns_deserialized_profile_metadata(self, dynamodb_table):
        """Verify that batch_get_profile_metadata returns Python-native types, not raw DDB JSON."""
        # Seed profiles into the moto table
        dynamodb_table.put_item(Item={
            'PK': 'PROFILE#p1', 'SK': '#METADATA',
            'name': 'Alice Smith', 'currentTitle': 'Engineer', 'currentCompany': 'Acme',
        })
        dynamodb_table.put_item(Item={
            'PK': 'PROFILE#p2', 'SK': '#METADATA',
            'name': 'Bob Jones', 'currentTitle': 'PM', 'currentCompany': 'Beta',
        })

        service = EdgeDataService(table=dynamodb_table)
        result = service.batch_get_profile_metadata(['p1', 'p2'])

        assert len(result) == 2
        # Values must be plain strings, not {'S': '...'} dicts
        assert result['p1']['name'] == 'Alice Smith'
        assert result['p1']['currentTitle'] == 'Engineer'
        assert result['p2']['name'] == 'Bob Jones'
        assert result['p2']['currentCompany'] == 'Beta'

    def test_returns_empty_for_missing_profiles(self, dynamodb_table):
        service = EdgeDataService(table=dynamodb_table)
        result = service.batch_get_profile_metadata(['nonexistent'])
        assert result == {}

    def test_returns_empty_for_empty_input(self, dynamodb_table):
        service = EdgeDataService(table=dynamodb_table)
        result = service.batch_get_profile_metadata([])
        assert result == {}

    def test_handles_more_than_100_profiles(self, dynamodb_table):
        """Verify chunking works for > 100 profile IDs."""
        for i in range(105):
            dynamodb_table.put_item(Item={
                'PK': f'PROFILE#p{i}', 'SK': '#METADATA',
                'name': f'Person {i}',
            })

        service = EdgeDataService(table=dynamodb_table)
        result = service.batch_get_profile_metadata([f'p{i}' for i in range(105)])

        assert len(result) == 105
        assert result['p0']['name'] == 'Person 0'
        assert result['p104']['name'] == 'Person 104'
