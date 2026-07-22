"""Command dispatch Lambda handler.

POST /commands — Create a command, dispatch to Electron agent via WebSocket.
GET /commands/{commandId} — Poll fallback for command status.

The command-creation path (rate-limit + create + WebSocket dispatch) lives in
the community-clean ``shared_services.command_dispatch_core`` module so the send
gates can call it in-process instead of invoking this Lambda. Per ADR-009 that
core (and this handler) stay agent- and quota-agnostic.
"""

import json
import logging
import os

import boto3
from shared_services.command_dispatch_core import create_command
from shared_services.observability import setup_correlation_context
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

_ALLOWED_METHODS = 'GET,POST,OPTIONS'


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

    # Delegate the create + rate-limit + WebSocket dispatch to the shared core,
    # then re-emit its (status, body) through api_response for the /commands route.
    status_code, body_obj = create_command(user_sub, command_type, payload)
    return api_response(status_code, body_obj, event, allowed_methods=_ALLOWED_METHODS)


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
