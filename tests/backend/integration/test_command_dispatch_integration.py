"""Integration tests for Command Dispatch Lambda."""

import json
import pytest
import time
from conftest import load_lambda_module

pytestmark = pytest.mark.integration

@pytest.fixture
def command_dispatch_module():
    """Load command-dispatch lambda module."""
    return load_lambda_module('command-dispatch')

@pytest.fixture
def command_dispatch_handler(command_dispatch_module):
    """Get command-dispatch lambda handler."""
    return command_dispatch_module.lambda_handler

class TestCommandDispatchIntegration:
    """Integration tests for Command Dispatch with Moto DynamoDB."""

    def test_create_command_flow(self, command_dispatch_module, command_dispatch_handler, dynamodb_table, monkeypatch):
        """Test the full command creation and dispatch flow."""
        user_id = 'test-user-cmd'
        
        # 1. Register an agent connection in DB using correct pattern
        dynamodb_table.put_item(Item={
            'PK': 'WSCONN#conn-agent-1',
            'SK': '#METADATA',
            'GSI1PK': f'USER#{user_id}#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'conn-agent-1',
            'userSub': user_id,
            'clientType': 'agent',
            'connectedAt': int(time.time())
        })
        
        # 2. Mock WebSocketService.send_to_connection
        from shared_services.websocket_service import WebSocketService
        monkeypatch.setattr(WebSocketService, 'send_to_connection', lambda self, conn_id, data: True)
        
        event = {
            'httpMethod': 'POST',
            'path': '/commands',
            'requestContext': {
                'authorizer': {'claims': {'sub': user_id}}
            },
            'body': json.dumps({
                'type': 'linkedin:search',
                'payload': {'query': 'test'}
            })
        }
        
        # 3. Call handler
        response = command_dispatch_handler(event, {})
        assert response['statusCode'] == 200
        
        body = json.loads(response['body'])
        command_id = body['commandId']
        assert body['status'] == 'dispatched'
        
        # 4. Verify command exists in DynamoDB
        db_response = dynamodb_table.get_item(
            Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'}
        )
        assert db_response['Item']['status'] == 'dispatched'

    def test_create_command_no_agent(self, command_dispatch_handler, dynamodb_table):
        """Test command creation when no agent is connected."""
        user_id = 'test-user-no-agent'
        
        event = {
            'httpMethod': 'POST',
            'path': '/commands',
            'requestContext': {
                'authorizer': {'claims': {'sub': user_id}}
            },
            'body': json.dumps({
                'type': 'linkedin:search'
            })
        }
        
        response = command_dispatch_handler(event, {})
        assert response['statusCode'] == 409
        assert 'No agent connected' in response['body']
