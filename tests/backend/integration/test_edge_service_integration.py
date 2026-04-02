"""Integration tests for EdgeService with MiniStack DynamoDB."""

import base64

import pytest

from shared_services.edge_data_service import EdgeDataService

pytestmark = pytest.mark.integration


class TestEdgeServiceIntegration:
    """Integration tests for EdgeService with MiniStack DynamoDB."""

    def test_full_upsert_flow(self, edge_service_module, ministack_dynamodb_table):
        """Test complete upsert flow with real DynamoDB."""
        service = EdgeDataService(table=ministack_dynamodb_table)

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

    def test_get_connections_by_status(self, edge_service_module, ministack_dynamodb_table):
        """Test retrieving connections by status."""
        service = EdgeDataService(table=ministack_dynamodb_table)

        service.upsert_status(user_id='test-user', profile_id='ally-profile-1', status='ally')
        service.upsert_status(user_id='test-user', profile_id='ally-profile-2', status='ally')
        service.upsert_status(user_id='test-user', profile_id='possible-profile', status='possible')

        result = service.get_connections_by_status('test-user', 'ally')

        assert 'connections' in result
        assert result['count'] == 2

    def test_add_message_to_edge(self, edge_service_module, ministack_dynamodb_table):
        """Test adding message to existing edge."""
        service = EdgeDataService(table=ministack_dynamodb_table)

        upsert_result = service.upsert_status(user_id='test-user', profile_id='test-profile', status='ally')
        profile_id_b64 = upsert_result['profileId']

        result = service.add_message(
            user_id='test-user',
            profile_id_b64=profile_id_b64,
            message='Hello, this is a test message',
            message_type='outbound',
        )

        assert result['success'] is True

        messages_result = service.get_messages('test-user', profile_id_b64)
        assert len(messages_result['messages']) == 1
        assert messages_result['messages'][0]['content'] == 'Hello, this is a test message'

    def test_check_exists(self, edge_service_module, ministack_dynamodb_table):
        """Test checking if edge exists."""
        service = EdgeDataService(table=ministack_dynamodb_table)

        nonexistent_b64 = base64.urlsafe_b64encode(b'nonexistent').decode()
        result = service.check_exists('test-user', nonexistent_b64)
        assert result['exists'] is False

        upsert_result = service.upsert_status('test-user', 'exists-profile', 'ally')
        profile_id_b64 = upsert_result['profileId']

        result = service.check_exists('test-user', profile_id_b64)
        assert result['exists'] is True
