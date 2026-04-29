"""WebSocket $disconnect route handler.

Removes the WSCONN#{connectionId} item from DynamoDB.
"""

import logging
import os

import boto3
from shared_services.observability import setup_correlation_context

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def lambda_handler(event, context):
    """Remove the WSCONN item for a disconnecting client.

    Every exception is caught so a missing connectionId or DynamoDB failure
    can't cause an uncaught Lambda crash during session teardown.
    """
    try:
        setup_correlation_context(event, context)

        request_context = event.get('requestContext') or {}
        connection_id = request_context.get('connectionId')
        if not connection_id:
            logger.warning('ws $disconnect missing connectionId')
            return {'statusCode': 400, 'body': 'Missing connectionId'}

        from shared_services.websocket_service import WebSocketService

        ws_service = WebSocketService(table, WEBSOCKET_ENDPOINT)

        # Capture metadata before deletion so we can notify the user's
        # frontend(s) if their agent went away.
        meta = ws_service.get_connection(connection_id) or {}
        ws_service.delete_connection(connection_id)
        logger.info('Disconnected: %s', connection_id)

        try:
            if meta.get('clientType') == 'agent' and meta.get('userSub') and WEBSOCKET_ENDPOINT:
                user_sub = meta['userSub']
                still_online = bool(ws_service.get_user_connections(user_sub, 'agent'))
                for browser in ws_service.get_user_connections(user_sub, 'browser'):
                    ws_service.send_to_connection(
                        browser['connectionId'],
                        {'action': 'agent_status', 'connected': still_online},
                    )
        except Exception:
            logger.exception('agent_status broadcast on disconnect failed (non-fatal)')

        return {'statusCode': 200, 'body': 'Disconnected'}
    except Exception:
        logger.exception('ws $disconnect handler failure')
        return {'statusCode': 500, 'body': 'Internal server error'}
