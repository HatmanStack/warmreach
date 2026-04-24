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
from shared_services.activity_writer import write_activity
from shared_services.observability import setup_correlation_context
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)
# Low-level client used for TransactWriteItems (atomic rate-limit + create).
ddb_client = boto3.client('dynamodb')

# Command TTL: 24 hours
COMMAND_TTL_SECONDS = 86400

# Rate limiting: max commands per user per minute
RATE_LIMIT_MAX = int(os.environ.get('COMMAND_RATE_LIMIT_MAX', '10'))
RATE_LIMIT_WINDOW = 60  # seconds

_ALLOWED_METHODS = 'GET,POST,OPTIONS'


class RateLimitUnavailableError(Exception):
    """Raised when the rate limit check fails due to a backend error (not actual rate limiting)."""


class RateLimitExceededError(Exception):
    """Raised when the rate limit would be exceeded (surfaced as 429 by handler)."""


def lambda_handler(event, context):
    setup_correlation_context(event, context)

    http_method = (event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method', '')).upper()

    if http_method == 'OPTIONS':
        return api_response(204, '', event, allowed_methods=_ALLOWED_METHODS)

    user_sub = extract_user_id(event)
    if not user_sub:
        return api_response(401, {'error': 'Authentication required'}, event, allowed_methods=_ALLOWED_METHODS)

    raw_path = event.get('rawPath', '') or event.get('path', '')

    if http_method == 'POST' and raw_path.rstrip('/').endswith('/commands'):
        return _create_command(event, user_sub)
    elif http_method == 'GET' and '/commands/' in raw_path:
        command_id = (event.get('pathParameters') or {}).get('commandId')
        if not command_id:
            # Extract from path
            parts = raw_path.rstrip('/').split('/')
            command_id = parts[-1] if parts else None
        if not command_id:
            return api_response(400, {'error': 'Missing commandId'}, event, allowed_methods=_ALLOWED_METHODS)
        return _get_command(command_id, user_sub, event)

    return api_response(404, {'error': 'Not found'}, event, allowed_methods=_ALLOWED_METHODS)


def _reserve_and_create_command(user_sub, command_id, command_type, payload):
    """Atomically reserve a rate-limit slot and create the pending command record.

    Uses DynamoDB TransactWriteItems so the rate-limit counter increment and the
    command record write either both succeed or both fail. This closes the gap
    where a rate-limit increment could commit without a corresponding command
    record (or vice versa).

    Returns the created command record (dict) on success.

    Raises:
        RateLimitExceededError: rate-limit condition failed; no writes committed.
        RateLimitUnavailableError: DynamoDB call failed for reasons other than
            the rate-limit condition (fail closed).
    """
    from boto3.dynamodb.types import TypeSerializer
    from botocore.exceptions import ClientError

    now = int(time.time())
    # Fixed-window bucket (epoch-aligned). A burst at the boundary can span two
    # buckets and observe up to 2x RATE_LIMIT_MAX — this is an accepted tradeoff
    # for a simple, atomic DynamoDB-backed counter. Do not "fix" by switching
    # windows without also switching to a sliding-window algorithm.
    window_key = now // RATE_LIMIT_WINDOW
    item = {
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

    serializer = TypeSerializer()
    serialized_item = {k: serializer.serialize(v) for k, v in item.items()}

    try:
        ddb_client.transact_write_items(
            TransactItems=[
                {
                    'Update': {
                        'TableName': TABLE_NAME,
                        'Key': {
                            'PK': {'S': f'USER#{user_sub}'},
                            'SK': {'S': f'RATELIMIT#cmd#{window_key}'},
                        },
                        'UpdateExpression': 'ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)',
                        'ConditionExpression': 'attribute_not_exists(#count) OR #count < :limit',
                        'ExpressionAttributeNames': {'#count': 'count', '#ttl': 'ttl'},
                        'ExpressionAttributeValues': {
                            ':inc': {'N': '1'},
                            ':ttl': {'N': str(now + RATE_LIMIT_WINDOW + 60)},
                            ':limit': {'N': str(RATE_LIMIT_MAX)},
                        },
                    }
                },
                {
                    'Put': {
                        'TableName': TABLE_NAME,
                        'Item': serialized_item,
                        # Defensive: guarantees idempotency if a retry reuses a uuid.
                        'ConditionExpression': 'attribute_not_exists(PK)',
                    }
                },
            ]
        )
        return item
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code == 'TransactionCanceledException':
            reasons = e.response.get('CancellationReasons') or []
            # Index 0 = rate-limit update; ConditionalCheckFailed => rate-limited.
            if reasons and reasons[0].get('Code') == 'ConditionalCheckFailed':
                raise RateLimitExceededError() from e
            logger.exception('Command transaction cancelled: %s', reasons)
            raise RateLimitUnavailableError(str(e)) from e
        logger.exception('Command transaction DynamoDB error')
        raise RateLimitUnavailableError(str(e)) from e
    except RateLimitExceededError:
        raise
    except Exception as e:
        logger.exception('Command transaction error')
        raise RateLimitUnavailableError(str(e)) from e


def _create_command(event, user_sub):
    raw_body = event.get('body')
    if raw_body:
        try:
            body = json.loads(raw_body)
        except json.JSONDecodeError:
            return api_response(400, {'error': 'Invalid JSON body'}, event, allowed_methods=_ALLOWED_METHODS)
    else:
        body = {}
    command_type = body.get('type')
    payload = body.get('payload', {})

    if not command_type:
        return api_response(400, {'error': 'type is required'}, event, allowed_methods=_ALLOWED_METHODS)

    from shared_services.websocket_service import WebSocketService

    ws_service = WebSocketService(table, WEBSOCKET_ENDPOINT)

    # Look up user's agent connection before reserving a rate-limit slot, so
    # we don't consume quota on guaranteed-409s.
    agent_conns = ws_service.get_user_connections(user_sub, 'agent')
    if not agent_conns:
        return api_response(409, {'error': 'No agent connected'}, event, allowed_methods=_ALLOWED_METHODS)

    agent_conn = agent_conns[0]
    command_id = str(uuid.uuid4())

    # Atomically reserve a rate-limit slot AND persist the pending command record.
    # TransactWriteItems guarantees the two writes commit together or not at all,
    # so we can never burn a rate-limit increment without a corresponding record
    # (or vice versa).
    try:
        _reserve_and_create_command(user_sub, command_id, command_type, payload)
    except RateLimitExceededError:
        return api_response(
            429,
            {
                'error': 'Too many commands. Please wait before sending more.',
                'code': 'RATE_LIMITED',
                'retryAfter': RATE_LIMIT_WINDOW,
            },
            event,
            allowed_methods=_ALLOWED_METHODS,
        )
    except RateLimitUnavailableError:
        return api_response(
            503,
            {
                'error': 'Rate limit check unavailable. Please try again.',
                'code': 'RATE_LIMIT_UNAVAILABLE',
            },
            event,
            allowed_methods=_ALLOWED_METHODS,
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
        return api_response(
            503,
            {
                'error': 'Agent disconnected',
                'commandId': command_id,
                'status': 'failed',
            },
            event,
            allowed_methods=_ALLOWED_METHODS,
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

    write_activity(table, user_sub, 'command_dispatched', metadata={'commandType': command_type})

    return api_response(200, {'commandId': command_id, 'status': 'dispatched'}, event, allowed_methods=_ALLOWED_METHODS)


def _get_command(command_id, user_sub, event):
    resp = table.get_item(Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'})
    item = resp.get('Item')
    if not item:
        return api_response(404, {'error': 'Command not found'}, event, allowed_methods=_ALLOWED_METHODS)

    # Ownership check
    if item.get('cognitoSub') != user_sub:
        return api_response(404, {'error': 'Command not found'}, event, allowed_methods=_ALLOWED_METHODS)

    return api_response(
        200,
        {
            'commandId': item['commandId'],
            'status': item['status'],
            'type': item['type'],
            'result': item.get('result'),
            'error': item.get('errorMessage'),
            'createdAt': item.get('createdAt'),
        },
        event,
        allowed_methods=_ALLOWED_METHODS,
    )
