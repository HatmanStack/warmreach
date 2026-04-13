"""Integration tests for Edge CRUD Lambda (formerly edge-processing)."""

import json
import pytest
import base64
from conftest import load_lambda_module

pytestmark = pytest.mark.integration

@pytest.fixture
def edge_module():
    """Load edge-crud lambda module."""
    return load_lambda_module('edge-crud')

@pytest.fixture
def edge_crud_handler(edge_module):
    """Get edge-crud lambda handler."""
    return edge_module.lambda_handler

class TestEdgeCrudIntegration:
    """Integration tests for Edge CRUD with Moto DynamoDB."""

    def test_get_connections_flow(self, edge_crud_handler, dynamodb_table):
        """Test fetching connections through the Lambda handler."""
        user_id = 'test-user-edge'

        # Seed edge
        profile_id_b64 = base64.urlsafe_b64encode(b'conn-1').decode()
        dynamodb_table.put_item(Item={
            'PK': f'USER#{user_id}',
            'SK': f'PROFILE#{profile_id_b64}',
            'status': 'ally',
            'GSI1PK': f'USER#{user_id}',
            'GSI1SK': f'STATUS#ally#PROFILE#{profile_id_b64}'
        })

        event = {
            'requestContext': {
                'authorizer': {'claims': {'sub': user_id}}
            },
            'body': json.dumps({
                'operation': 'get_connections_by_status',
                'updates': {'status': 'ally'}
            })
        }

        response = edge_crud_handler(event, {})
        assert response['statusCode'] == 200

        body = json.loads(response['body'])
        assert 'connections' in body
        assert len(body['connections']) == 1

    def test_get_messages_flow(self, edge_crud_handler, dynamodb_table):
        """Test fetching messages through the Lambda handler.

        Note: The edge-crud handler passes profileId from the request body
        directly to EdgeDataService.get_messages(), which calls
        encode_profile_id() internally. So the request must send the raw
        profile ID, not the base64 version.
        """
        user_id = 'test-user-edge'
        profile_id = 'conn-msgs'
        profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()

        # Seed edge with messages (SK uses the b64-encoded profile ID)
        dynamodb_table.put_item(Item={
            'PK': f'USER#{user_id}',
            'SK': f'PROFILE#{profile_id_b64}',
            'id': profile_id,
            'messages': [
                {'content': 'Hello', 'type': 'inbound', 'timestamp': '2024-01-01T10:00:00Z'},
                {'content': 'Hi back', 'type': 'outbound', 'timestamp': '2024-01-01T10:05:00Z'}
            ]
        })

        # Pass raw profile_id — the service encodes it internally
        event = {
            'requestContext': {
                'authorizer': {'claims': {'sub': user_id}}
            },
            'body': json.dumps({
                'operation': 'get_messages',
                'profileId': profile_id
            })
        }

        response = edge_crud_handler(event, {})
        assert response['statusCode'] == 200

        body = json.loads(response['body'])
        assert 'messages' in body
        assert len(body['messages']) == 2
