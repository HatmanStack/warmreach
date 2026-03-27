"""Unit tests for EdgeDataService - edge CRUD operations."""
import base64
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared_services.base_service import BaseService

# We'll import EdgeDataService after creating it
# For now, the path is set up via conftest.py's sys.path
from shared_services.edge_data_service import (
    MAX_NOTES_PER_EDGE,
    OPPORTUNITY_OUTCOMES,
    OPPORTUNITY_STAGES,
    EdgeDataService,
    encode_profile_id,
)

from errors.exceptions import ExternalServiceError, ValidationError


class TestEncodeProfileId:
    """Tests for encode_profile_id helper."""

    def test_encodes_profile_id(self):
        result = encode_profile_id('john-doe-123')
        expected = base64.urlsafe_b64encode(b'john-doe-123').decode()
        assert result == expected

    def test_round_trip(self):
        original = 'https://linkedin.com/in/jane-smith'
        encoded = encode_profile_id(original)
        decoded = base64.urlsafe_b64decode(encoded).decode()
        assert decoded == original

    def test_handles_special_characters(self):
        pid = 'profile/with+special=chars'
        encoded = encode_profile_id(pid)
        decoded = base64.urlsafe_b64decode(encoded).decode()
        assert decoded == pid


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

    def _make_service(self):
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_client = MagicMock()
        service = EdgeDataService(table=mock_table, dynamodb_client=mock_client)
        return service, mock_table, mock_client

    def test_creates_forward_and_reverse_edges(self):
        service, mock_table, mock_client = self._make_service()

        result = service.upsert_status(
            user_id='test-user',
            profile_id='https://linkedin.com/in/john',
            status='possible',
        )

        assert result['success'] is True
        mock_client.transact_write_items.assert_called_once()

    def test_returns_b64_profile_id(self):
        service, mock_table, mock_client = self._make_service()

        result = service.upsert_status(
            user_id='test-user',
            profile_id='https://linkedin.com/in/john',
            status='possible',
        )

        decoded = base64.urlsafe_b64decode(result['profileId']).decode()
        assert decoded == 'https://linkedin.com/in/john'

    def test_updates_existing_edge(self):
        service, mock_table, mock_client = self._make_service()

        result = service.upsert_status(
            user_id='test-user',
            profile_id='test-profile',
            status='ally',
        )

        assert result['success'] is True
        assert result['status'] == 'ally'

    def test_dynamo_error_raises_external_service_error(self):
        service, mock_table, mock_client = self._make_service()
        mock_client.transact_write_items.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'TransactWriteItems',
        )

        with pytest.raises(ExternalServiceError):
            service.upsert_status('test-user', 'profile', 'ally')

    def test_triggers_ingestion_for_ally_status(self):
        service, mock_table, mock_client = self._make_service()
        mock_table.get_item.return_value = {'Item': {'name': 'John'}}

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
        service = EdgeDataService(table=mock_table)
        service.batch_get_profile_metadata = MagicMock(return_value={
            'dGVzdA==': {'name': 'John Doe', 'headline': 'Engineer'}
        })

        result = service.get_connections_by_status('test-user', 'ally')

        assert result['success'] is True
        assert len(result['connections']) == 1
        service.batch_get_profile_metadata.assert_called_once_with(['dGVzdA=='])

    def test_empty_edges_skips_batch_fetch(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        service = EdgeDataService(table=mock_table)
        service.batch_get_profile_metadata = MagicMock(return_value={})

        result = service.get_connections_by_status('test-user', 'ally')

        assert result['success'] is True
        assert result['connections'] == []
        service.batch_get_profile_metadata.assert_not_called()

    def test_missing_profile_metadata_uses_empty_dict(self):
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
        service = EdgeDataService(table=mock_table)
        # Simulate missing profile in batch result
        service.batch_get_profile_metadata = MagicMock(return_value={})

        result = service.get_connections_by_status('test-user', 'ally')

        assert result['success'] is True
        assert len(result['connections']) == 1
        conn = result['connections'][0]
        assert conn['first_name'] == ''
        assert conn['last_name'] == ''


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


class TestUpsertStatusAtomicTransaction:
    """Tests for atomic TransactWriteItems in upsert_status."""

    def test_upsert_status_atomic_writes_both_items(self, dynamodb_table):
        """Call upsert_status, verify both forward and reverse edges exist."""
        import boto3
        dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
        service = EdgeDataService(table=dynamodb_table, dynamodb_client=dynamodb_client)

        profile_id = 'https://linkedin.com/in/atomic-test'
        profile_id_b64 = encode_profile_id(profile_id)

        result = service.upsert_status('test-user', profile_id, 'possible')

        assert result['success'] is True

        # Verify forward edge exists
        forward = dynamodb_table.get_item(
            Key={'PK': 'USER#test-user', 'SK': f'PROFILE#{profile_id_b64}'}
        )
        assert 'Item' in forward
        assert forward['Item']['status'] == 'possible'

        # Verify reverse edge exists
        reverse = dynamodb_table.get_item(
            Key={'PK': f'PROFILE#{profile_id_b64}', 'SK': 'USER#test-user'}
        )
        assert 'Item' in reverse
        assert reverse['Item']['status'] == 'possible'

    def test_upsert_status_transaction_failure(self):
        """Mock transact_write_items to raise TransactionCanceledException,
        verify neither edge exists and ExternalServiceError is raised."""
        mock_table = MagicMock()
        mock_client = MagicMock()
        mock_table.table_name = 'test-table'
        mock_client.transact_write_items.side_effect = ClientError(
            {
                'Error': {'Code': 'TransactionCanceledException', 'Message': 'Transaction cancelled'},
                'CancellationReasons': [
                    {'Code': 'None'},
                    {'Code': 'ConditionalCheckFailed', 'Message': 'Condition not met'},
                ],
            },
            'TransactWriteItems',
        )
        service = EdgeDataService(table=mock_table, dynamodb_client=mock_client)

        with pytest.raises(ExternalServiceError):
            service.upsert_status('test-user', 'test-profile', 'ally')

        # No delete_item rollback should be called (transaction handles atomicity)
        mock_table.delete_item.assert_not_called()

    def test_upsert_status_no_rollback_code(self):
        """Verify no delete_item rollback code remains in upsert_status."""
        mock_table = MagicMock()
        mock_client = MagicMock()
        mock_table.table_name = 'test-table'
        service = EdgeDataService(table=mock_table, dynamodb_client=mock_client)

        service.upsert_status('test-user', 'test-profile', 'possible')

        # put_item and update_item should NOT be called separately
        mock_table.put_item.assert_not_called()
        # transact_write_items should be called on the low-level client
        mock_client.transact_write_items.assert_called_once()


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


# =============================================================================
# Note CRUD Tests
# =============================================================================


class TestAddNote:
    """Tests for add_note operation."""

    def test_successful_note_addition(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        result = service.add_note('test-user', 'https://linkedin.com/in/john', 'Great conversation')

        assert result['success'] is True
        assert 'noteId' in result
        assert result['profileId'] is not None
        mock_table.update_item.assert_called_once()

    def test_note_has_uuid_id(self):
        import uuid

        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        result = service.add_note('test-user', 'test-profile', 'A note')

        # noteId should be a valid UUID
        uuid.UUID(result['noteId'])  # Will raise ValueError if invalid

    def test_note_uses_list_append(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        service.add_note('test-user', 'test-profile', 'A note')

        call_kwargs = mock_table.update_item.call_args[1]
        assert 'list_append' in call_kwargs['UpdateExpression']
        assert 'if_not_exists' in call_kwargs['UpdateExpression']

    def test_note_has_timestamp_and_updated_at(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        service.add_note('test-user', 'test-profile', 'A note')

        call_kwargs = mock_table.update_item.call_args[1]
        note_obj = call_kwargs['ExpressionAttributeValues'][':note'][0]
        assert 'timestamp' in note_obj
        assert 'updatedAt' in note_obj
        assert note_obj['timestamp'] == note_obj['updatedAt']

    def test_empty_content_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_note('test-user', 'test-profile', '')

    def test_whitespace_content_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_note('test-user', 'test-profile', '   ')

    def test_content_over_1000_chars_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_note('test-user', 'test-profile', 'x' * 1001)

    def test_dynamo_error_raises_external_service_error(self):
        mock_table = MagicMock()
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'UpdateItem',
        )
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.add_note('test-user', 'test-profile', 'A note')

    def test_base64_encodes_profile_id(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        result = service.add_note('test-user', 'https://linkedin.com/in/john', 'A note')

        call_kwargs = mock_table.update_item.call_args[1]
        expected_b64 = base64.urlsafe_b64encode(b'https://linkedin.com/in/john').decode()
        assert call_kwargs['Key']['SK'] == f'PROFILE#{expected_b64}'
        assert result['profileId'] == expected_b64

    def test_note_cap_exceeded_raises_validation_error(self):
        """When DynamoDB rejects due to ConditionExpression (notes at cap), raise ValidationError."""
        mock_table = MagicMock()
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'Condition not met'}},
            'UpdateItem',
        )
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError, match='Maximum'):
            service.add_note('test-user', 'test-profile', 'One too many')

    def test_note_cap_condition_expression_present(self):
        """add_note should include a ConditionExpression enforcing MAX_NOTES_PER_EDGE atomically."""
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        service.add_note('test-user', 'test-profile', 'A note')

        call_kwargs = mock_table.update_item.call_args[1]
        assert 'ConditionExpression' in call_kwargs
        assert ':max_notes' in str(call_kwargs['ExpressionAttributeValues'])
        assert call_kwargs['ExpressionAttributeValues'][':max_notes'] == MAX_NOTES_PER_EDGE


class TestUpdateNote:
    """Tests for update_note operation."""

    def test_successful_update(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'Old content', 'timestamp': '2024-01-01T00:00:00+00:00', 'updatedAt': '2024-01-01T00:00:00+00:00'},
                ]
            }
        }
        service = EdgeDataService(table=mock_table)

        result = service.update_note('test-user', 'test-profile', 'note-1', 'New content')

        assert result['success'] is True
        assert result['noteId'] == 'note-1'
        mock_table.update_item.assert_called_once()

    def test_updates_content_and_updated_at(self):
        mock_table = MagicMock()
        old_timestamp = '2024-01-01T00:00:00+00:00'
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'Old', 'timestamp': old_timestamp, 'updatedAt': old_timestamp},
                ]
            }
        }
        service = EdgeDataService(table=mock_table)

        service.update_note('test-user', 'test-profile', 'note-1', 'New content')

        call_kwargs = mock_table.update_item.call_args[1]
        updated_notes = call_kwargs['ExpressionAttributeValues'][':notes']
        assert updated_notes[0]['content'] == 'New content'
        assert updated_notes[0]['timestamp'] == old_timestamp  # timestamp preserved
        assert updated_notes[0]['updatedAt'] != old_timestamp  # updatedAt changed

    def test_note_not_found_raises_validation_error(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'Content', 'timestamp': '2024-01-01', 'updatedAt': '2024-01-01'},
                ]
            }
        }
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError, match='Note not found'):
            service.update_note('test-user', 'test-profile', 'nonexistent-note', 'New content')

    def test_empty_content_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError):
            service.update_note('test-user', 'test-profile', 'note-1', '')

    def test_content_over_1000_chars_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError):
            service.update_note('test-user', 'test-profile', 'note-1', 'x' * 1001)


class TestDeleteNote:
    """Tests for delete_note operation."""

    def test_successful_delete(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'Content', 'timestamp': '2024-01-01', 'updatedAt': '2024-01-01'},
                    {'id': 'note-2', 'content': 'Other', 'timestamp': '2024-01-02', 'updatedAt': '2024-01-02'},
                ]
            }
        }
        service = EdgeDataService(table=mock_table)

        result = service.delete_note('test-user', 'test-profile', 'note-1')

        assert result['success'] is True
        assert result['noteId'] == 'note-1'
        # Verify the remaining notes list excludes note-1
        call_kwargs = mock_table.update_item.call_args[1]
        remaining = call_kwargs['ExpressionAttributeValues'][':notes']
        assert len(remaining) == 1
        assert remaining[0]['id'] == 'note-2'

    def test_note_not_found_raises_validation_error(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'Content', 'timestamp': '2024-01-01', 'updatedAt': '2024-01-01'},
                ]
            }
        }
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError, match='Note not found'):
            service.delete_note('test-user', 'test-profile', 'nonexistent')

    def test_dynamo_error_raises_external_service_error(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'GetItem',
        )
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.delete_note('test-user', 'test-profile', 'note-1')


class TestFormatConnectionObjectNotes:
    """Tests for notes in _format_connection_object."""

    def test_notes_included_in_connection(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)
        notes = [{'id': 'n1', 'content': 'A note', 'timestamp': '2024-01-01', 'updatedAt': '2024-01-01'}]
        edge_item = {'status': 'ally', 'messages': [], 'notes': notes}
        profile_data = {'name': 'John Doe'}

        result = service._format_connection_object('profile-1', profile_data, edge_item)

        assert result['notes'] == notes

    def test_empty_notes_when_not_present(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)
        edge_item = {'status': 'ally', 'messages': []}
        profile_data = {'name': 'John Doe'}

        result = service._format_connection_object('profile-1', profile_data, edge_item)

        assert result['notes'] == []


# ---- Opportunity Stage Management Tests ----


class TestTagConnectionToOpportunity:
    """Tests for tag_connection_to_opportunity method."""

    def test_tag_creates_opportunity_entry(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'PK': 'USER#user-1', 'SK': 'PROFILE#pid1', 'opportunities': []}
        }
        mock_table.update_item.return_value = {}

        service = EdgeDataService(table=mock_table)
        result = service.tag_connection_to_opportunity('user-1', 'pid1', 'opp-1')

        assert result['success'] is True
        assert result['stage'] == 'identified'
        mock_table.update_item.assert_called_once()

    def test_tag_with_custom_stage(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'PK': 'USER#user-1', 'SK': 'PROFILE#pid1'}
        }
        mock_table.update_item.return_value = {}

        service = EdgeDataService(table=mock_table)
        result = service.tag_connection_to_opportunity('user-1', 'pid1', 'opp-1', stage='reached_out')

        assert result['stage'] == 'reached_out'

    def test_duplicate_tag_raises_error(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-1',
                'SK': 'PROFILE#pid1',
                'opportunities': [{'opportunityId': 'opp-1', 'stage': 'identified'}],
            }
        }

        service = EdgeDataService(table=mock_table)
        with pytest.raises(ValidationError, match='already tagged'):
            service.tag_connection_to_opportunity('user-1', 'pid1', 'opp-1')


class TestUntagConnectionFromOpportunity:
    """Tests for untag_connection_from_opportunity method."""

    def test_untag_removes_entry(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-1',
                'SK': 'PROFILE#pid1',
                'opportunities': [
                    {'opportunityId': 'opp-1', 'stage': 'identified'},
                    {'opportunityId': 'opp-2', 'stage': 'met'},
                ],
            }
        }
        mock_table.update_item.return_value = {}

        service = EdgeDataService(table=mock_table)
        result = service.untag_connection_from_opportunity('user-1', 'pid1', 'opp-1')

        assert result['success'] is True
        # Verify the update call has only opp-2 remaining
        call_kwargs = mock_table.update_item.call_args[1]
        opps = call_kwargs['ExpressionAttributeValues'][':opps']
        assert len(opps) == 1
        assert opps[0]['opportunityId'] == 'opp-2'


class TestUpdateConnectionStage:
    """Tests for update_connection_stage method."""

    def test_stage_update_changes_matching_opportunity(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-1',
                'SK': 'PROFILE#pid1',
                'opportunities': [
                    {'opportunityId': 'opp-1', 'stage': 'identified'},
                    {'opportunityId': 'opp-2', 'stage': 'met'},
                ],
            }
        }
        mock_table.update_item.return_value = {}

        service = EdgeDataService(table=mock_table)
        result = service.update_connection_stage('user-1', 'pid1', 'opp-1', 'reached_out')

        assert result['success'] is True
        assert result['oldStage'] == 'identified'
        assert result['newStage'] == 'reached_out'

    def test_invalid_stage_raises_error(self):
        mock_table = MagicMock()
        service = EdgeDataService(table=mock_table)

        with pytest.raises(ValidationError, match='Invalid stage'):
            service.update_connection_stage('user-1', 'pid1', 'opp-1', 'invalid_stage')


class TestGetOpportunityConnections:
    """Tests for get_opportunity_connections method."""

    def test_returns_connections_grouped_by_stage(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#user-1',
                    'SK': 'PROFILE#pid1',
                    'opportunities': [{'opportunityId': 'opp-1', 'stage': 'identified'}],
                    'first_name': 'Alice',
                    'last_name': 'Smith',
                },
                {
                    'PK': 'USER#user-1',
                    'SK': 'PROFILE#pid2',
                    'opportunities': [{'opportunityId': 'opp-1', 'stage': 'reached_out'}],
                    'first_name': 'Bob',
                    'last_name': 'Jones',
                },
                {
                    'PK': 'USER#user-1',
                    'SK': 'PROFILE#pid3',
                    'opportunities': [{'opportunityId': 'other', 'stage': 'met'}],
                    'first_name': 'Carol',
                    'last_name': 'White',
                },
            ],
            'LastEvaluatedKey': None,
        }

        service = EdgeDataService(table=mock_table)
        result = service.get_opportunity_connections('user-1', 'opp-1')

        assert result['success'] is True
        assert result['totalCount'] == 2
        assert len(result['stages']['identified']) == 1
        assert len(result['stages']['reached_out']) == 1
        assert result['stages']['identified'][0]['profileId'] == 'pid1'


class TestOpportunityConstants:
    """Tests for opportunity-related constants."""

    def test_stages_are_defined(self):
        assert OPPORTUNITY_STAGES == ['identified', 'reached_out', 'replied', 'met', 'outcome']

    def test_outcomes_are_defined(self):
        assert OPPORTUNITY_OUTCOMES == ['won', 'lost', 'stalled']
