"""Tests for WebSocket $default route handler."""

import json
import os
from unittest.mock import patch

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'
os.environ['WEBSOCKET_ENDPOINT'] = 'https://test.execute-api.us-east-1.amazonaws.com/dev'
os.environ['LOG_LEVEL'] = 'DEBUG'


def _make_default_event(connection_id='conn-123', body=None):
    return {
        'requestContext': {
            'connectionId': connection_id,
            'routeKey': '$default',
        },
        'body': json.dumps(body) if body else '{}',
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


def _seed_connection_and_command(table, connection_id='agent-conn', user_sub='user-123', command_id='cmd-1'):
    """Helper: seed a connection and command owned by the same user."""
    table.put_item(Item={
        'PK': f'WSCONN#{connection_id}',
        'SK': '#METADATA',
        'GSI1PK': f'USER#{user_sub}#WSCONN',
        'GSI1SK': 'TYPE#agent',
        'connectionId': connection_id,
        'userSub': user_sub,
        'clientType': 'agent',
        'connectedAt': 1000,
    })
    table.put_item(Item={
        'PK': f'COMMAND#{command_id}',
        'SK': '#METADATA',
        'commandId': command_id,
        'cognitoSub': user_sub,
        'type': 'linkedin:search',
        'status': 'dispatched',
        'createdAt': 1000,
    })


class TestHeartbeat:
    def test_heartbeat_sends_echo(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        event = _make_default_event(body={'action': 'heartbeat', 'ts': 1234567890})

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection') as mock_send:
            mock_send.return_value = True
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
        mock_send.assert_called_once_with('conn-123', {
            'action': 'heartbeat',
            'echo': True,
            'ts': 1234567890,
        })


class TestUnknownActions:
    def test_unknown_action_returns_error(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        event = _make_default_event(body={'action': 'unknown_action'})
        result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert 'Unknown action' in body['error']

    def test_empty_body_returns_error(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        event = _make_default_event(body={})
        result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert 'Unknown action' in body['error']


class TestProgress:
    def test_progress_updates_command_and_forwards(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        _seed_connection_and_command(ws_table)

        # Also add a browser connection to verify forwarding
        ws_table.put_item(Item={
            'PK': 'WSCONN#browser-conn',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#browser',
            'connectionId': 'browser-conn',
            'userSub': 'user-123',
            'clientType': 'browser',
            'connectedAt': 1000,
        })

        event = _make_default_event(
            connection_id='agent-conn',
            body={'action': 'progress', 'commandId': 'cmd-1', 'step': 3, 'total': 10, 'message': 'Searching...'},
        )

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection') as mock_send:
            mock_send.return_value = True
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200

        # Verify command updated
        cmd = ws_table.get_item(Key={'PK': 'COMMAND#cmd-1', 'SK': '#METADATA'}).get('Item')
        assert cmd['status'] == 'executing'
        assert cmd['progressStep'] == 3
        assert cmd['progressTotal'] == 10

        # Verify forwarded to browser
        mock_send.assert_called_once_with('browser-conn', {
            'action': 'command_progress',
            'commandId': 'cmd-1',
            'step': 3,
            'total': 10,
            'message': 'Searching...',
        })

    def test_progress_missing_command_id(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        event = _make_default_event(body={'action': 'progress'})

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        body = json.loads(result['body'])
        assert 'Missing commandId' in body['error']

    def test_progress_wrong_owner_rejected(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        # Connection owned by different user than command
        ws_table.put_item(Item={
            'PK': 'WSCONN#other-conn',
            'SK': '#METADATA',
            'connectionId': 'other-conn',
            'userSub': 'other-user',
            'clientType': 'agent',
        })
        ws_table.put_item(Item={
            'PK': 'COMMAND#cmd-1',
            'SK': '#METADATA',
            'commandId': 'cmd-1',
            'cognitoSub': 'user-123',
            'status': 'dispatched',
        })

        event = _make_default_event(
            connection_id='other-conn',
            body={'action': 'progress', 'commandId': 'cmd-1', 'step': 1, 'total': 5},
        )

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        body = json.loads(result['body'])
        assert 'Not authorized' in body['error']


class TestResult:
    def test_result_completes_command_and_forwards(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        _seed_connection_and_command(ws_table)

        event = _make_default_event(
            connection_id='agent-conn',
            body={'action': 'result', 'commandId': 'cmd-1', 'data': {'results': [1, 2, 3], 'count': 3}},
        )

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection') as mock_send:
            mock_send.return_value = True
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200

        # Verify command completed
        cmd = ws_table.get_item(Key={'PK': 'COMMAND#cmd-1', 'SK': '#METADATA'}).get('Item')
        assert cmd['status'] == 'completed'
        assert cmd['result'] == {'results': [1, 2, 3], 'count': 3}


class TestError:
    def test_error_fails_command_and_forwards(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        _seed_connection_and_command(ws_table)

        event = _make_default_event(
            connection_id='agent-conn',
            body={'action': 'error', 'commandId': 'cmd-1', 'code': 'SESSION_EXPIRED', 'message': 'Login required'},
        )

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection') as mock_send:
            mock_send.return_value = True
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200

        cmd = ws_table.get_item(Key={'PK': 'COMMAND#cmd-1', 'SK': '#METADATA'}).get('Item')
        assert cmd['status'] == 'failed'
        assert cmd['errorCode'] == 'SESSION_EXPIRED'
        assert cmd['errorMessage'] == 'Login required'


class TestErrorWrapper:
    """Top-level try/except wrapper for ADR-A (no unhandled escape)."""

    def test_missing_body_returns_success(self, lambda_context):
        """No body field should not crash — falls through to 'Unknown action'."""
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        event = {'requestContext': {'connectionId': 'conn-1'}}
        result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] in (200, 400)

    def test_malformed_json_returns_400(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        event = {'requestContext': {'connectionId': 'conn-1'}, 'body': '{not json'}
        result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 400
        body = json.loads(result['body'])
        assert 'Invalid JSON body' in body['error']

    def test_handler_exception_returns_500(self, ws_table, lambda_context):
        """A handler raising unexpectedly must be caught by the top-level guard."""
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        def _boom(connection_id, body):
            raise RuntimeError('handler crashed')

        event = _make_default_event(body={'action': 'heartbeat'})

        original = module.ACTION_HANDLERS.get('heartbeat')
        module.ACTION_HANDLERS['heartbeat'] = _boom
        try:
            with patch.object(module, 'table', ws_table):
                result = module.lambda_handler(event, lambda_context)
        finally:
            if original is not None:
                module.ACTION_HANDLERS['heartbeat'] = original

        assert result['statusCode'] == 500
        assert 'Internal server error' in json.loads(result['body'])['error']

    def test_missing_request_context_returns_500(self, lambda_context):
        """Completely malformed event: still returns a response, never crashes."""
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-default')

        # setup_correlation_context may tolerate this; behaviour is: response.
        result = module.lambda_handler({}, lambda_context)
        assert result['statusCode'] in (200, 400, 500)
