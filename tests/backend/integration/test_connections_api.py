"""Integration tests for Connections API (dynamodb-api Lambda)."""

import json
import pytest
from conftest import load_lambda_module

pytestmark = pytest.mark.integration

@pytest.fixture
def dynamodb_api_handler():
    """Load dynamodb-api lambda handler."""
    return load_lambda_module('dynamodb-api').lambda_handler

class TestConnectionsApiIntegration:
    """Integration tests for Connections API with Moto DynamoDB."""

    def test_get_user_settings_flow(self, dynamodb_api_handler, dynamodb_table):
        """Test fetching user settings through the Lambda handler."""
        user_id = 'test-user-api'
        
        # Seed user settings
        dynamodb_table.put_item(Item={
            'PK': f'USER#{user_id}',
            'SK': '#SETTINGS',
            'email': 'test@example.com',
            'theme': 'dark'
        })
        
        event = {
            'httpMethod': 'GET',
            'requestContext': {
                'authorizer': {'claims': {'sub': user_id}}
            }
        }
        
        response = dynamodb_api_handler(event, {})
        assert response['statusCode'] == 200
        
        body = json.loads(response['body'])
        assert body['email'] == 'test@example.com'
        assert body['theme'] == 'dark'

    def test_create_bad_contact_flow(self, dynamodb_api_handler, dynamodb_table):
        """Test creating bad contact profile through the Lambda handler."""
        user_id = 'test-user-api'
        profile_id = 'bad-conn'
        
        event = {
            'requestContext': {
                'authorizer': {'claims': {'sub': user_id}}
            },
            'body': json.dumps({
                'operation': 'create',
                'profileId': profile_id,
                'updates': {'name': 'Spammer'}
            })
        }
        
        response = dynamodb_api_handler(event, {})
        assert response['statusCode'] == 201
        
        # Verify in DB
        import base64
        profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()
        db_response = dynamodb_table.get_item(
            Key={'PK': f'PROFILE#{profile_id_b64}', 'SK': '#METADATA'}
        )
        assert db_response['Item']['name'] == 'Spammer'
        assert db_response['Item']['evaluated'] is True
