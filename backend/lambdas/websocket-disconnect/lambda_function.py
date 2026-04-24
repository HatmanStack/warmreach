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

        ws_service = WebSocketService(table, '')  # No endpoint needed for delete

        ws_service.delete_connection(connection_id)
        logger.info('Disconnected: %s', connection_id)

        return {'statusCode': 200, 'body': 'Disconnected'}
    except Exception:
        logger.exception('ws $disconnect handler failure')
        return {'statusCode': 500, 'body': 'Internal server error'}
