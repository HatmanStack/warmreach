"""Integration tests for WebSocket Lambda handlers."""

import json
import pytest
from conftest import load_lambda_module

pytestmark = pytest.mark.integration

@pytest.fixture
def ws_connect_module():
    return load_lambda_module('websocket-connect')

@pytest.fixture
def ws_connect_handler(ws_connect_module):
    return ws_connect_module.lambda_handler

@pytest.fixture
def ws_disconnect_handler():
    return load_lambda_module('websocket-disconnect').lambda_handler

class TestWebSocketIntegration:
    """Integration tests for WebSocket lifecycle with Moto DynamoDB."""

    def test_websocket_lifecycle(self, ws_connect_module, ws_connect_handler, ws_disconnect_handler, dynamodb_table, monkeypatch):
        """Test $connect and $disconnect flow."""
        user_id = 'test-user-ws'
        conn_id = 'conn-123'
        
        # 1. Mock JWT validation
        monkeypatch.setattr(ws_connect_module, '_validate_jwt', lambda token: {'sub': user_id})
        
        # 2. $connect
        event_connect = {
            'requestContext': {'connectionId': conn_id},
            'queryStringParameters': {'token': 'valid-token', 'clientType': 'browser'}
        }
        
        # Mock disconnect_connection to avoid real API calls
        from shared_services.websocket_service import WebSocketService
        monkeypatch.setattr(WebSocketService, 'disconnect_connection', lambda self, cid: True)
        
        response = ws_connect_handler(event_connect, {})
        assert response['statusCode'] == 200
        
        # Verify connection stored in DB
        db_response = dynamodb_table.get_item(
            Key={'PK': f'WSCONN#{conn_id}', 'SK': '#METADATA'}
        )
        assert 'Item' in db_response
        assert db_response['Item']['userSub'] == user_id
        
        # 3. $disconnect
        event_disconnect = {
            'requestContext': {'connectionId': conn_id}
        }
        
        response = ws_disconnect_handler(event_disconnect, {})
        assert response['statusCode'] == 200
        
        # Verify connection removed from DB
        db_response = dynamodb_table.get_item(
            Key={'PK': f'WSCONN#{conn_id}', 'SK': '#METADATA'}
        )
        assert 'Item' not in db_response

    def test_single_client_per_user_enforcement(self, ws_connect_module, ws_connect_handler, dynamodb_table, monkeypatch):
        """Test that new connection replaces old one for same user/type."""
        user_id = 'test-user-single'
        old_conn_id = 'old-conn'
        new_conn_id = 'new-conn'
        
        # Seed old connection with correct GSI pattern
        dynamodb_table.put_item(Item={
            'PK': f'WSCONN#{old_conn_id}',
            'SK': '#METADATA',
            'GSI1PK': f'USER#{user_id}#WSCONN',
            'GSI1SK': 'TYPE#browser',
            'connectionId': old_conn_id,
            'clientType': 'browser',
            'userSub': user_id
        })
        
        monkeypatch.setattr(ws_connect_module, '_validate_jwt', lambda token: {'sub': user_id})
        from shared_services.websocket_service import WebSocketService
        disconnect_spy = []
        monkeypatch.setattr(WebSocketService, 'disconnect_connection', lambda self, cid: disconnect_spy.append(cid))
        
        event_connect = {
            'requestContext': {'connectionId': new_conn_id},
            'queryStringParameters': {'token': 'valid-token', 'clientType': 'browser'}
        }
        
        ws_connect_handler(event_connect, {})
        
        # Verify old connection was disconnected (from WebSocketService point of view)
        assert old_conn_id in disconnect_spy
        
        # Verify new connection exists
        db_response = dynamodb_table.get_item(
            Key={'PK': f'WSCONN#{new_conn_id}', 'SK': '#METADATA'}
        )
        assert 'Item' in db_response
