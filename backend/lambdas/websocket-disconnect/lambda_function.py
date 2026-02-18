"""WebSocket $disconnect route handler.

Removes the WSCONN#{connectionId} item from DynamoDB.
"""

import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def lambda_handler(event, context):
    from shared_services.observability import setup_correlation_context

    setup_correlation_context(event, context)

    connection_id = event['requestContext']['connectionId']

    from shared_services.websocket_service import WebSocketService

    ws_service = WebSocketService(table, '')  # No endpoint needed for delete

    ws_service.delete_connection(connection_id)
    logger.info(f'Disconnected: {connection_id}')

    return {'statusCode': 200, 'body': 'Disconnected'}
