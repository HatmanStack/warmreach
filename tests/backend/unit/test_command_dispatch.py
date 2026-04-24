"""Tests for command-dispatch Lambda handler."""

import json
import os
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'
os.environ['WEBSOCKET_ENDPOINT'] = 'https://test.execute-api.us-east-1.amazonaws.com/dev'
os.environ['ALLOWED_ORIGINS'] = 'http://localhost:5173'
os.environ['LOG_LEVEL'] = 'DEBUG'


def _make_http_event(method='POST', path='/commands', body=None, user_id='user-123', path_params=None):
    event = {
        'httpMethod': method,
        'rawPath': path,
        'path': path,
        'headers': {
            'Content-Type': 'application/json',
            'origin': 'http://localhost:5173',
        },
        'queryStringParameters': None,
        'pathParameters': path_params,
        'body': json.dumps(body) if body else None,
        'requestContext': {
            'authorizer': {
                'jwt': {
                    'claims': {'sub': user_id},
                },
            },
        },
    }
    return event


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


class TestCreateCommand:
    def test_missing_type_returns_400(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        event = _make_http_event(body={'payload': {}})
        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 400
        assert 'type is required' in json.loads(result['body'])['error']

    def test_no_agent_returns_409(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        event = _make_http_event(body={'type': 'linkedin:search', 'payload': {'q': 'test'}})
        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 409
        assert 'No agent connected' in json.loads(result['body'])['error']

    def test_successful_dispatch(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        # Pre-populate agent connection
        ws_table.put_item(Item={
            'PK': 'WSCONN#agent-conn-1',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'agent-conn-1',
            'userSub': 'user-123',
            'clientType': 'agent',
            'connectedAt': 1000,
        })

        event = _make_http_event(body={'type': 'linkedin:search', 'payload': {'query': 'test'}})

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['status'] == 'dispatched'
        assert 'commandId' in body

        # Verify command stored in DDB
        cmd = ws_table.get_item(
            Key={'PK': f'COMMAND#{body["commandId"]}', 'SK': '#METADATA'}
        ).get('Item')
        assert cmd is not None
        assert cmd['type'] == 'linkedin:search'
        assert cmd['cognitoSub'] == 'user-123'
        assert cmd['status'] == 'dispatched'

    def test_agent_gone_during_dispatch(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        ws_table.put_item(Item={
            'PK': 'WSCONN#agent-conn-1',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'agent-conn-1',
            'userSub': 'user-123',
            'clientType': 'agent',
            'connectedAt': 1000,
        })

        event = _make_http_event(body={'type': 'linkedin:search', 'payload': {}})

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=False):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 503
        body = json.loads(result['body'])
        assert body['error'] == 'Agent disconnected'
        assert body['status'] == 'failed'
        assert 'commandId' in body

    def test_rate_limit_exceeded_returns_429(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        # Pre-populate agent connection
        ws_table.put_item(Item={
            'PK': 'WSCONN#agent-conn-1',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'agent-conn-1',
            'userSub': 'user-123',
            'clientType': 'agent',
            'connectedAt': 1000,
        })

        event = _make_http_event(body={'type': 'linkedin:search', 'payload': {}})

        # Set rate limit to 2 for testing
        original_limit = module.RATE_LIMIT_MAX
        module.RATE_LIMIT_MAX = 2

        try:
            with patch.object(module, 'table', ws_table), \
                 patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True):
                # First two should succeed
                result1 = module.lambda_handler(event, lambda_context)
                assert result1['statusCode'] == 200

                result2 = module.lambda_handler(event, lambda_context)
                assert result2['statusCode'] == 200

                # Third should be rate limited
                result3 = module.lambda_handler(event, lambda_context)
                assert result3['statusCode'] == 429
                body = json.loads(result3['body'])
                assert body['code'] == 'RATE_LIMITED'
                assert 'retryAfter' in body
        finally:
            module.RATE_LIMIT_MAX = original_limit

    def test_unauthenticated_returns_401(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        event = _make_http_event(body={'type': 'test'})
        event['requestContext']['authorizer'] = {}

        result = module.lambda_handler(event, lambda_context)
        assert result['statusCode'] == 401


class TestGetCommand:
    def test_get_own_command(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        ws_table.put_item(Item={
            'PK': 'COMMAND#cmd-123',
            'SK': '#METADATA',
            'commandId': 'cmd-123',
            'cognitoSub': 'user-123',
            'type': 'linkedin:search',
            'status': 'completed',
            'result': {'count': 5},
            'createdAt': 1000,
        })

        event = _make_http_event(
            method='GET',
            path='/commands/cmd-123',
            path_params={'commandId': 'cmd-123'},
        )

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['commandId'] == 'cmd-123'
        assert body['status'] == 'completed'
        assert body['result'] == {'count': '5'}  # Decimal→str via json.dumps(default=str)

    def test_get_other_users_command_returns_404(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        ws_table.put_item(Item={
            'PK': 'COMMAND#cmd-other',
            'SK': '#METADATA',
            'commandId': 'cmd-other',
            'cognitoSub': 'other-user',
            'type': 'linkedin:search',
            'status': 'completed',
        })

        event = _make_http_event(
            method='GET',
            path='/commands/cmd-other',
            path_params={'commandId': 'cmd-other'},
        )

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 404

    def test_get_nonexistent_command_returns_404(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        event = _make_http_event(
            method='GET',
            path='/commands/nonexistent',
            path_params={'commandId': 'nonexistent'},
        )

        with patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 404


class TestReserveAndCreateCommandTransactional:
    """Verify _reserve_and_create_command is atomic (rate-limit + create commit together)."""

    def test_rate_limit_conditional_check_raises_rate_limit_exceeded(self, ws_table, lambda_context):
        """TransactionCanceledException with ConditionalCheckFailed on the rate-limit
        update maps to RateLimitExceededError, and no command record is persisted."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        from botocore.exceptions import ClientError

        error = ClientError(
            {
                'Error': {'Code': 'TransactionCanceledException', 'Message': 'canceled'},
                'CancellationReasons': [
                    {'Code': 'ConditionalCheckFailed'},
                    {'Code': 'None'},
                ],
            },
            'TransactWriteItems',
        )

        with patch.object(module, 'table', ws_table):
            with patch.object(module.ddb_client, 'transact_write_items', side_effect=error):
                with pytest.raises(module.RateLimitExceededError):
                    module._reserve_and_create_command('user-123', 'cmd-1', 't', {})

        # Neither write should have committed.
        assert ws_table.get_item(
            Key={'PK': 'COMMAND#cmd-1', 'SK': '#METADATA'}
        ).get('Item') is None

    def test_put_condition_failure_rolls_back_rate_limit_increment(self, ws_table, lambda_context):
        """If the Put side of the transaction fails, the rate-limit increment must
        also be rolled back (atomicity)."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        from botocore.exceptions import ClientError

        # Simulate TransactWriteItems cancelling for a non-rate-limit reason
        # (e.g. the Put ConditionExpression 'attribute_not_exists(PK)' failed).
        error = ClientError(
            {
                'Error': {'Code': 'TransactionCanceledException', 'Message': 'canceled'},
                'CancellationReasons': [
                    {'Code': 'None'},
                    {'Code': 'ConditionalCheckFailed'},
                ],
            },
            'TransactWriteItems',
        )

        with patch.object(module, 'table', ws_table):
            with patch.object(module.ddb_client, 'transact_write_items', side_effect=error):
                with pytest.raises(module.RateLimitUnavailableError):
                    module._reserve_and_create_command('user-123', 'cmd-2', 't', {})

        # No command record should exist (atomic rollback).
        assert ws_table.get_item(
            Key={'PK': 'COMMAND#cmd-2', 'SK': '#METADATA'}
        ).get('Item') is None

    def test_unexpected_client_error_raises_unavailable(self, ws_table, lambda_context):
        """Unexpected ClientError (not TransactionCanceledException) must raise RateLimitUnavailableError."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        from botocore.exceptions import ClientError

        error = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'DDB failure'}},
            'TransactWriteItems',
        )
        with patch.object(module, 'table', ws_table):
            with patch.object(module.ddb_client, 'transact_write_items', side_effect=error):
                with pytest.raises(module.RateLimitUnavailableError):
                    module._reserve_and_create_command('user-123', 'cmd-3', 't', {})

    def test_generic_exception_raises_unavailable(self, ws_table, lambda_context):
        """Generic Exception must raise RateLimitUnavailableError."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        with patch.object(module, 'table', ws_table):
            with patch.object(module.ddb_client, 'transact_write_items', side_effect=RuntimeError('boom')):
                with pytest.raises(module.RateLimitUnavailableError):
                    module._reserve_and_create_command('user-123', 'cmd-4', 't', {})

    def test_provisioned_throughput_exceeded_does_not_return_429(self, ws_table, lambda_context):
        """ProvisionedThroughputExceededException is a network/backend error, not a
        rate-limit hit; it must not surface as 429 (which would trigger the wrong
        client retry strategy)."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        from botocore.exceptions import ClientError

        error = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'hot partition'}},
            'TransactWriteItems',
        )
        with patch.object(module, 'table', ws_table):
            with patch.object(module.ddb_client, 'transact_write_items', side_effect=error):
                with pytest.raises(module.RateLimitUnavailableError):
                    module._reserve_and_create_command('user-123', 'cmd-5', 't', {})

    def test_dynamo_error_returns_503_to_caller(self, ws_table, lambda_context):
        """DynamoDB error during reserve+create should surface as 503 to the caller."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        # Pre-populate agent connection
        ws_table.put_item(Item={
            'PK': 'WSCONN#agent-conn-1',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'agent-conn-1',
            'userSub': 'user-123',
            'clientType': 'agent',
            'connectedAt': 1000,
        })

        event = _make_http_event(body={'type': 'linkedin:search', 'payload': {}})
        with patch.object(module, 'table', ws_table), \
             patch.object(module, '_reserve_and_create_command',
                          side_effect=module.RateLimitUnavailableError('fail')):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 503
        body = json.loads(result['body'])
        assert body['code'] == 'RATE_LIMIT_UNAVAILABLE'

    def test_successful_transaction_creates_command_record(self, ws_table, lambda_context):
        """Happy path: transact_write_items succeeds and command record is written."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        with patch.object(module, 'table', ws_table):
            item = module._reserve_and_create_command('user-123', 'cmd-happy', 'linkedin:search', {'q': 'x'})

        assert item['commandId'] == 'cmd-happy'
        assert item['status'] == 'pending'
        stored = ws_table.get_item(
            Key={'PK': 'COMMAND#cmd-happy', 'SK': '#METADATA'}
        ).get('Item')
        assert stored is not None
        assert stored['status'] == 'pending'


class TestActivityWriterInstrumentation:
    def test_successful_dispatch_emits_activity(self, ws_table, lambda_context):
        """Successful command dispatch calls write_activity."""
        from conftest import load_lambda_module
        module = load_lambda_module('command-dispatch')

        ws_table.put_item(Item={
            'PK': 'WSCONN#agent-conn-1',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#agent',
            'connectionId': 'agent-conn-1',
            'userSub': 'user-123',
            'clientType': 'agent',
            'connectedAt': 1000,
        })

        event = _make_http_event(body={'type': 'linkedin:search', 'payload': {'query': 'test'}})

        with patch.object(module, 'table', ws_table), \
             patch('shared_services.websocket_service.WebSocketService.send_to_connection', return_value=True), \
             patch.object(module, 'write_activity') as mock_wa:
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200
        mock_wa.assert_called_once()
        args = mock_wa.call_args[0]
        kwargs = mock_wa.call_args[1]
        assert args[2] == 'command_dispatched'
        assert kwargs['metadata']['commandType'] == 'linkedin:search'
