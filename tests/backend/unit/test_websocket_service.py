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

    def test_store_connection_sets_a_ttl_that_cannot_reap_a_live_connection(self, ws_table):
        """MEDIUM #16: $disconnect is best-effort, so an orphaned WSCONN# used to
        survive forever and make an offline agent look online. The TTL must sit
        beyond API Gateway's 24h maximum WebSocket duration so it can only ever
        reap a connection that is already dead."""
        import time as _time

        from shared_services.websocket_service import WSCONN_TTL_SECONDS

        service = self._make_service(ws_table)
        before = int(_time.time())
        service.store_connection('conn-ttl', 'user-abc', 'agent')

        item = ws_table.get_item(Key={'PK': 'WSCONN#conn-ttl', 'SK': '#METADATA'})['Item']
        ttl = int(item['ttl'])
        assert WSCONN_TTL_SECONDS == 26 * 3600
        # Comfortably past the 24h ceiling, and anchored to now rather than fixed.
        assert ttl > before + 24 * 3600
        assert before + WSCONN_TTL_SECONDS <= ttl <= before + WSCONN_TTL_SECONDS + 5

    def test_ttl_attribute_name_matches_the_one_command_items_use(self, ws_table):
        """DynamoDB allows one TTL attribute per table, so a second name would
        silently never expire."""
        from shared_services.command_dispatch_core import COMMAND_TTL_SECONDS

        assert COMMAND_TTL_SECONDS  # the COMMAND# TTL this reuses the name of
        service = self._make_service(ws_table)
        service.store_connection('conn-name', 'user-abc', 'browser')
        item = ws_table.get_item(Key={'PK': 'WSCONN#conn-name', 'SK': '#METADATA'})['Item']
        assert 'ttl' in item
        assert not [k for k in item if k.lower().endswith('ttl') and k != 'ttl']

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

    def test_disconnect_already_gone_logs_info(self, ws_table, caplog):
        """GoneException on disconnect must log (not silently swallow)."""
        import logging
        from botocore.exceptions import ClientError
        service = self._make_service(ws_table)
        service.store_connection('conn-1', 'user-abc', 'browser')

        service.apigw.delete_connection.side_effect = ClientError(
            {'Error': {'Code': 'GoneException', 'Message': 'Gone'}},
            'DeleteConnection',
        )
        with caplog.at_level(logging.INFO):
            service.disconnect_connection('conn-1')
        assert any('conn-1' in r.getMessage() for r in caplog.records)


class TestExpiredConnectionsAreNotReturned:
    """DynamoDB TTL deletion lags by up to 48 hours, so the index still returns
    rows past their `ttl`. An expired row makes an offline agent look online,
    and create_command then burns a rate-limit slot and writes a COMMAND#
    before finding out the connection is gone."""

    def test_the_query_filters_on_ttl(self, dynamodb_table):
        from shared_services.websocket_service import WebSocketService

        captured = {}

        class _Table:
            name = 'test-table'

            def query(self, **kwargs):
                captured.update(kwargs)
                return {'Items': []}

        WebSocketService(_Table()).get_user_connections('user-1')

        assert 'FilterExpression' in captured, 'expired rows are not filtered out'
        assert '#ttl' in captured['FilterExpression']
        # Rows written before the ttl attribute existed must survive: nothing is
        # known about their age, and dropping them would hide live agents.
        assert 'attribute_not_exists' in captured['FilterExpression']
        assert captured['ExpressionAttributeNames']['#ttl'] == 'ttl'
        assert isinstance(captured['ExpressionAttributeValues'][':now'], int)
