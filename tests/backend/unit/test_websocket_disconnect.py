"""Tests for WebSocket $disconnect handler."""

import os
from unittest.mock import patch

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'
os.environ['LOG_LEVEL'] = 'DEBUG'


def _make_disconnect_event(connection_id='conn-123'):
    return {
        'requestContext': {
            'connectionId': connection_id,
            'routeKey': '$disconnect',
        },
        'headers': {},
    }


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


class TestWebSocketDisconnect:
    def test_disconnect_removes_connection(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-disconnect')

        # Pre-populate connection
        ws_table.put_item(Item={
            'PK': 'WSCONN#conn-123',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-1#WSCONN',
            'GSI1SK': 'TYPE#browser',
            'connectionId': 'conn-123',
            'userSub': 'user-1',
            'clientType': 'browser',
            'connectedAt': 1000,
        })

        event = _make_disconnect_event('conn-123')

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200

        # Connection should be gone
        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-123', 'SK': '#METADATA'}
        ).get('Item')
        assert item is None

    def test_disconnect_nonexistent_connection_succeeds(self, ws_table, lambda_context):
        """Disconnecting a connection that doesn't exist should not error."""
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-disconnect')

        event = _make_disconnect_event('nonexistent-conn')

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
