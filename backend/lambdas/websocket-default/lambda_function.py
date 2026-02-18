"""WebSocket $default route handler.

Routes messages by the 'action' field:
- heartbeat: echo back to sender
- progress: agent reports progress on a command, forwarded to browser
- result: agent reports command completion, forwarded to browser
- error: agent reports command failure, forwarded to browser
"""

import json
import logging
import os
import time

import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

ACTION_HANDLERS = {}


def _register(action_name):
    def decorator(fn):
        ACTION_HANDLERS[action_name] = fn
        return fn

    return decorator


def lambda_handler(event, context):
    from shared_services.observability import setup_correlation_context

    setup_correlation_context(event, context)

    connection_id = event['requestContext']['connectionId']
    body = json.loads(event.get('body', '{}'))
    action = body.get('action', '')

    logger.info(f'Message from {connection_id}: action={action}')

    handler = ACTION_HANDLERS.get(action)
    if handler:
        return handler(connection_id, body)

    logger.warning(f'Unknown action: {action}')
    return {'statusCode': 200, 'body': json.dumps({'error': f'Unknown action: {action}'})}


def _get_ws_service():
    from shared_services.websocket_service import WebSocketService

    return WebSocketService(table, WEBSOCKET_ENDPOINT)


def _validate_command_ownership(connection_id, command_id):
    """Verify the sender owns the command. Returns (command_item, error_response)."""
    # Look up the connection to get cognitoSub
    conn = table.get_item(Key={'PK': f'WSCONN#{connection_id}', 'SK': '#METADATA'}).get('Item')
    if not conn:
        return None, {'statusCode': 200, 'body': json.dumps({'error': 'Connection not found'})}

    # Look up the command
    cmd = table.get_item(Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'}).get('Item')
    if not cmd:
        return None, {'statusCode': 200, 'body': json.dumps({'error': 'Command not found'})}

    if cmd.get('cognitoSub') != conn.get('userSub'):
        return None, {'statusCode': 200, 'body': json.dumps({'error': 'Not authorized'})}

    return cmd, None


def _forward_to_browser(user_sub, message):
    """Forward a message to the user's browser connection(s)."""
    ws_service = _get_ws_service()
    browser_conns = ws_service.get_user_connections(user_sub, 'browser')
    for bc in browser_conns:
        ws_service.send_to_connection(bc['connectionId'], message)


@_register('heartbeat')
def _handle_heartbeat(connection_id, body):
    ws_service = _get_ws_service()
    ws_service.send_to_connection(
        connection_id,
        {
            'action': 'heartbeat',
            'echo': True,
            'ts': body.get('ts'),
        },
    )
    return {'statusCode': 200, 'body': 'ok'}


@_register('progress')
def _handle_progress(connection_id, body):
    command_id = body.get('commandId')
    if not command_id:
        return {'statusCode': 200, 'body': json.dumps({'error': 'Missing commandId'})}

    cmd, err = _validate_command_ownership(connection_id, command_id)
    if err:
        return err

    # Update command with progress info
    table.update_item(
        Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
        UpdateExpression='SET #s = :s, #step = :step, #total = :total, #msg = :msg, #ua = :ua',
        ExpressionAttributeNames={
            '#s': 'status',
            '#step': 'progressStep',
            '#total': 'progressTotal',
            '#msg': 'progressMessage',
            '#ua': 'updatedAt',
        },
        ExpressionAttributeValues={
            ':s': 'executing',
            ':step': body.get('step', 0),
            ':total': body.get('total', 0),
            ':msg': body.get('message', ''),
            ':ua': int(time.time()),
        },
    )

    # Forward to browser
    _forward_to_browser(
        cmd['cognitoSub'],
        {
            'action': 'command_progress',
            'commandId': command_id,
            'step': body.get('step', 0),
            'total': body.get('total', 0),
            'message': body.get('message', ''),
        },
    )

    return {'statusCode': 200, 'body': 'ok'}


@_register('result')
def _handle_result(connection_id, body):
    command_id = body.get('commandId')
    if not command_id:
        return {'statusCode': 200, 'body': json.dumps({'error': 'Missing commandId'})}

    cmd, err = _validate_command_ownership(connection_id, command_id)
    if err:
        return err

    result_data = body.get('data', {})

    # Update command as completed
    table.update_item(
        Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
        UpdateExpression='SET #s = :s, #r = :r, #ua = :ua',
        ExpressionAttributeNames={
            '#s': 'status',
            '#r': 'result',
            '#ua': 'updatedAt',
        },
        ExpressionAttributeValues={
            ':s': 'completed',
            ':r': result_data,
            ':ua': int(time.time()),
        },
    )

    # Forward to browser
    _forward_to_browser(
        cmd['cognitoSub'],
        {
            'action': 'command_result',
            'commandId': command_id,
            'data': result_data,
        },
    )

    return {'statusCode': 200, 'body': 'ok'}


@_register('error')
def _handle_error(connection_id, body):
    command_id = body.get('commandId')
    if not command_id:
        return {'statusCode': 200, 'body': json.dumps({'error': 'Missing commandId'})}

    cmd, err = _validate_command_ownership(connection_id, command_id)
    if err:
        return err

    error_code = body.get('code', 'UNKNOWN')
    error_message = body.get('message', 'Unknown error')

    # Update command as failed
    table.update_item(
        Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
        UpdateExpression='SET #s = :s, #ec = :ec, #em = :em, #ua = :ua',
        ExpressionAttributeNames={
            '#s': 'status',
            '#ec': 'errorCode',
            '#em': 'errorMessage',
            '#ua': 'updatedAt',
        },
        ExpressionAttributeValues={
            ':s': 'failed',
            ':ec': error_code,
            ':em': error_message,
            ':ua': int(time.time()),
        },
    )

    # Forward to browser
    _forward_to_browser(
        cmd['cognitoSub'],
        {
            'action': 'command_error',
            'commandId': command_id,
            'code': error_code,
            'message': error_message,
        },
    )

    return {'statusCode': 200, 'body': 'ok'}
