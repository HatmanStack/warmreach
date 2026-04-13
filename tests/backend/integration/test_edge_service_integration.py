"""Integration tests for EdgeService with MiniStack DynamoDB."""

import base64

import pytest

from shared_services.edge_data_service import EdgeDataService

pytestmark = pytest.mark.integration


def _make_service(table):
    """Create EdgeDataService with MiniStack-compatible low-level client."""
    svc = EdgeDataService(table=table)
    # EdgeStatusService needs a low-level DynamoDB client for transact_write_items
    if hasattr(table, '_ministack_client'):
        svc._status_svc._dynamodb_client_override = table._ministack_client
    return svc


class TestEdgeServiceIntegration:
    """Integration tests for EdgeService with MiniStack DynamoDB."""

    def test_full_upsert_flow(self, ministack_dynamodb_table):
        """Test complete upsert flow with real DynamoDB."""
        service = _make_service(ministack_dynamodb_table)

        result = service.upsert_status(
            user_id='test-user',
            profile_id='test-profile',
            status='ally',
            added_at='2024-01-15T12:00:00Z',
        )

        assert result['success'] is True
        assert 'profileId' in result

        profile_id_b64 = result['profileId']

        response = ministack_dynamodb_table.get_item(
            Key={'PK': 'USER#test-user', 'SK': f'PROFILE#{profile_id_b64}'}
        )
        assert 'Item' in response
        assert response['Item']['status'] == 'ally'

    def test_get_connections_by_status(self, ministack_dynamodb_table):
        """Test retrieving connections by status."""
        service = _make_service(ministack_dynamodb_table)

        service.upsert_status(user_id='test-user', profile_id='ally-profile-1', status='ally')
        service.upsert_status(user_id='test-user', profile_id='ally-profile-2', status='ally')
        service.upsert_status(user_id='test-user', profile_id='possible-profile', status='possible')

        result = service.get_connections_by_status('test-user', 'ally')

        assert 'connections' in result
        assert result['count'] == 2

    def test_add_message_to_edge(self, ministack_dynamodb_table):
        """Test adding message to existing edge.

        Note: EdgeDataService methods accept raw profile IDs and
        call encode_profile_id() internally.
        """
        service = _make_service(ministack_dynamodb_table)

        service.upsert_status(user_id='test-user', profile_id='test-profile', status='ally')

        result = service.add_message(
            user_id='test-user',
            profile_id='test-profile',
            message='Hello, this is a test message',
            message_type='outbound',
        )

        assert result['success'] is True

        messages_result = service.get_messages('test-user', 'test-profile')
        assert len(messages_result['messages']) == 1
        assert messages_result['messages'][0]['content'] == 'Hello, this is a test message'

    def test_check_exists(self, ministack_dynamodb_table):
        """Test checking if edge exists.

        Note: EdgeDataService methods accept raw profile IDs and
        call encode_profile_id() internally.
        """
        service = _make_service(ministack_dynamodb_table)

        result = service.check_exists('test-user', 'nonexistent')
        assert result['exists'] is False

        service.upsert_status('test-user', 'exists-profile', 'ally')

        result = service.check_exists('test-user', 'exists-profile')
        assert result['exists'] is True
