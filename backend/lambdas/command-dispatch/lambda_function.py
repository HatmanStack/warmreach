"""Command dispatch Lambda handler.

POST /commands — Create a command, dispatch to Electron agent via WebSocket.
GET /commands/{commandId} — Poll fallback for command status.
"""

import json
import logging
import os
import time
import uuid

import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

ALLOWED_ORIGINS_ENV = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173')
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(',') if o.strip()]

# Command TTL: 24 hours
COMMAND_TTL_SECONDS = 86400

# Rate limiting: max commands per user per minute
RATE_LIMIT_MAX = int(os.environ.get('COMMAND_RATE_LIMIT_MAX', '10'))
RATE_LIMIT_WINDOW = 60  # seconds


def _extract_user_id(event):
    rc = event.get('requestContext') or {}
    auth = rc.get('authorizer') or {}
    jwt_claims = (auth.get('jwt') or {}).get('claims') or {}
    if jwt_claims.get('sub'):
        return jwt_claims['sub']
    rest_claims = auth.get('claims') or {}
    return rest_claims.get('sub')


def _get_origin(event):
    headers = event.get('headers') or {}
    return headers.get('origin') or headers.get('Origin')


def _response(status_code, body, origin=None):
    allow_origin = origin if origin in ALLOWED_ORIGINS else (ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else '*')
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allow_origin,
            'Vary': 'Origin',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        },
        'body': json.dumps(body, default=str),
    }


def lambda_handler(event, context):
    from shared_services.observability import setup_correlation_context

    setup_correlation_context(event, context)

    http_method = (event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method', '')).upper()
    origin = _get_origin(event)

    if http_method == 'OPTIONS':
        return _response(204, '', origin)

    user_sub = _extract_user_id(event)
    if not user_sub:
        return _response(401, {'error': 'Authentication required'}, origin)

    raw_path = event.get('rawPath', '') or event.get('path', '')

    if http_method == 'POST' and raw_path.rstrip('/').endswith('/commands'):
        return _create_command(event, user_sub, origin)
    elif http_method == 'GET' and '/commands/' in raw_path:
        command_id = (event.get('pathParameters') or {}).get('commandId')
        if not command_id:
            # Extract from path
            parts = raw_path.rstrip('/').split('/')
            command_id = parts[-1] if parts else None
        if not command_id:
            return _response(400, {'error': 'Missing commandId'}, origin)
        return _get_command(command_id, user_sub, origin)

    return _response(404, {'error': 'Not found'}, origin)


def _check_rate_limit(user_sub):
    """Check per-user command rate limit using DynamoDB atomic counter. Returns True if allowed."""
    now = int(time.time())
    window_key = now // RATE_LIMIT_WINDOW  # bucket per minute

    try:
        from botocore.exceptions import ClientError

        table.update_item(
            Key={'PK': f'USER#{user_sub}', 'SK': f'RATELIMIT#cmd#{window_key}'},
            UpdateExpression='ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)',
            ConditionExpression='attribute_not_exists(#count) OR #count < :limit',
            ExpressionAttributeNames={'#count': 'count', '#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':inc': 1,
                ':ttl': now + RATE_LIMIT_WINDOW + 60,  # TTL with buffer
                ':limit': RATE_LIMIT_MAX,
            },
        )
        return True
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False
        logger.warning(f'Rate limit check error: {e}')
        return True  # Allow on error (fail open)
    except Exception as e:
        logger.warning(f'Rate limit check error: {e}')
        return True


def _create_command(event, user_sub, origin):
    body = json.loads(event.get('body', '{}')) if event.get('body') else {}
    command_type = body.get('type')
    payload = body.get('payload', {})

    if not command_type:
        return _response(400, {'error': 'type is required'}, origin)

    # Rate limit check
    if not _check_rate_limit(user_sub):
        return _response(
            429,
            {
                'error': 'Too many commands. Please wait before sending more.',
                'code': 'RATE_LIMITED',
                'retryAfter': RATE_LIMIT_WINDOW,
            },
            origin,
        )

    from shared_services.websocket_service import WebSocketService

    ws_service = WebSocketService(table, WEBSOCKET_ENDPOINT)

    # Look up user's agent connection
    agent_conns = ws_service.get_user_connections(user_sub, 'agent')
    if not agent_conns:
        return _response(409, {'error': 'No agent connected'}, origin)

    agent_conn = agent_conns[0]
    command_id = str(uuid.uuid4())
    now = int(time.time())

    # Create command record
    table.put_item(
        Item={
            'PK': f'COMMAND#{command_id}',
            'SK': '#METADATA',
            'commandId': command_id,
            'cognitoSub': user_sub,
            'type': command_type,
            'payload': payload,
            'status': 'pending',
            'createdAt': now,
            'ttl': now + COMMAND_TTL_SECONDS,
        }
    )

    # Dispatch to agent
    sent = ws_service.send_to_connection(
        agent_conn['connectionId'],
        {
            'action': 'execute',
            'commandId': command_id,
            'type': command_type,
            'payload': payload,
        },
    )

    if not sent:
        # Agent connection is gone — mark failed and tell client immediately
        table.update_item(
            Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
            UpdateExpression='SET #s = :s',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': 'failed'},
        )
        return _response(
            503,
            {
                'error': 'Agent disconnected',
                'commandId': command_id,
                'status': 'failed',
            },
            origin,
        )

    # Update status to dispatched
    table.update_item(
        Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
        UpdateExpression='SET #s = :s',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':s': 'dispatched'},
    )

    # Notify browser if connected
    browser_conns = ws_service.get_user_connections(user_sub, 'browser')
    for bc in browser_conns:
        ws_service.send_to_connection(
            bc['connectionId'],
            {
                'action': 'command_queued',
                'commandId': command_id,
            },
        )

    return _response(200, {'commandId': command_id, 'status': 'dispatched'}, origin)


def _get_command(command_id, user_sub, origin):
    resp = table.get_item(Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'})
    item = resp.get('Item')
    if not item:
        return _response(404, {'error': 'Command not found'}, origin)

    # Ownership check
    if item.get('cognitoSub') != user_sub:
        return _response(404, {'error': 'Command not found'}, origin)

    return _response(
        200,
        {
            'commandId': item['commandId'],
            'status': item['status'],
            'type': item['type'],
            'result': item.get('result'),
            'error': item.get('errorMessage'),
            'createdAt': item.get('createdAt'),
        },
        origin,
    )
