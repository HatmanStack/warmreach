"""Tests for WebSocketService shared service."""

import os
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'


@pytest.fixture
def ws_table(aws_credentials):
    with mock_aws():
        import boto3
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'GSI1',
                    'KeySchema': [
                        {'AttributeName': 'GSI1PK', 'KeyType': 'HASH'},
                        {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'},
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5,
                    },
                }
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )
        yield table


class TestWebSocketService:
    def _make_service(self, table):
        from shared_services.websocket_service import WebSocketService
        service = WebSocketService(table, 'https://test.execute-api.us-east-1.amazonaws.com/dev')
        service.apigw = MagicMock()
        return service

    def test_store_connection(self, ws_table):
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'browser')

        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-1', 'SK': '#METADATA'}
        ).get('Item')

        assert item is not None
        assert item['userSub'] == 'user-abc'
        assert item['clientType'] == 'browser'
        assert item['GSI1PK'] == 'USER#user-abc#WSCONN'
        assert item['GSI1SK'] == 'TYPE#browser'

    def test_delete_connection(self, ws_table):
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'browser')
        service.delete_connection('conn-1')

        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-1', 'SK': '#METADATA'}
        ).get('Item')
        assert item is None

    def test_get_connection(self, ws_table):
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'agent')

        item = service.get_connection('conn-1')
        assert item is not None
        assert item['connectionId'] == 'conn-1'

    def test_get_connection_not_found(self, ws_table):
        service = self._make_service(ws_table)
        item = service.get_connection('nonexistent')
        assert item is None

    def test_get_user_connections(self, ws_table):
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'browser')
        service.store_connection('conn-2', 'user-abc', 'agent')
        service.store_connection('conn-3', 'user-other', 'browser')

        # All connections for user-abc
        conns = service.get_user_connections('user-abc')
        assert len(conns) == 2

        # Filter by type
        agent_conns = service.get_user_connections('user-abc', 'agent')
        assert len(agent_conns) == 1
        assert agent_conns[0]['connectionId'] == 'conn-2'

    def test_send_to_connection_success(self, ws_table):
        service = self._make_service(ws_table)
        service.apigw.post_to_connection.return_value = {}

        result = service.send_to_connection('conn-1', {'action': 'heartbeat'})
        assert result is True
        service.apigw.post_to_connection.assert_called_once()

    def test_send_to_connection_gone(self, ws_table):
        from botocore.exceptions import ClientError
        service = self._make_service(ws_table)

        # Pre-store connection so cleanup can remove it
        service.store_connection('conn-gone', 'user-1', 'browser')

        service.apigw.post_to_connection.side_effect = ClientError(
            {'Error': {'Code': 'GoneException', 'Message': 'Gone'}},
            'PostToConnection',
        )

        result = service.send_to_connection('conn-gone', {'action': 'test'})
        assert result is False

        # Connection should be cleaned up
        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-gone', 'SK': '#METADATA'}
        ).get('Item')
        assert item is None

    def test_disconnect_connection(self, ws_table):
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'browser')

        service.apigw.delete_connection.return_value = {}
        service.disconnect_connection('conn-1')

        # Should be removed from DDB
        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-1', 'SK': '#METADATA'}
        ).get('Item')
        assert item is None

    def test_disconnect_already_gone(self, ws_table):
        from botocore.exceptions import ClientError
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'browser')

        service.apigw.delete_connection.side_effect = ClientError(
            {'Error': {'Code': 'GoneException', 'Message': 'Gone'}},
            'DeleteConnection',
        )

        # Should not raise
        service.disconnect_connection('conn-1')

        # DDB item should still be cleaned up
        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-1', 'SK': '#METADATA'}
        ).get('Item')
        assert item is None
