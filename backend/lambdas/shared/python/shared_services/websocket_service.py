"""WebSocket connection management service.

Provides helpers for the @connections API Gateway Management API
and DynamoDB connection tracking.
"""

import logging
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


class WebSocketService:
    """Manages WebSocket connections via API Gateway Management API and DynamoDB."""

    def __init__(self, table, endpoint_url: str = ''):
        self.table = table
        self._endpoint_url = endpoint_url
        self._apigw = None

    @property
    def apigw(self):
        """Lazy-init APIGW management client (only needed for send/disconnect)."""
        if self._apigw is None:
            self._apigw = boto3.client(
                'apigatewaymanagementapi',
                endpoint_url=self._endpoint_url,
            )
        return self._apigw

    @apigw.setter
    def apigw(self, value):
        self._apigw = value

    def store_connection(
        self,
        connection_id: str,
        user_sub: str,
        client_type: str,
    ) -> None:
        """Write WSCONN item to DynamoDB."""
        self.table.put_item(
            Item={
                'PK': f'WSCONN#{connection_id}',
                'SK': '#METADATA',
                'GSI1PK': f'USER#{user_sub}#WSCONN',
                'GSI1SK': f'TYPE#{client_type}',
                'connectionId': connection_id,
                'userSub': user_sub,
                'clientType': client_type,
                'connectedAt': int(time.time()),
            }
        )

    def delete_connection(self, connection_id: str) -> None:
        """Remove WSCONN item from DynamoDB."""
        self.table.delete_item(Key={'PK': f'WSCONN#{connection_id}', 'SK': '#METADATA'})

    def get_connection(self, connection_id: str) -> dict | None:
        """Fetch a single connection record."""
        resp = self.table.get_item(Key={'PK': f'WSCONN#{connection_id}', 'SK': '#METADATA'})
        return resp.get('Item')

    def get_user_connections(self, user_sub: str, client_type: str | None = None) -> list[dict]:
        """Query GSI1 for a user's WebSocket connections, optionally filtered by type."""
        key_condition = 'GSI1PK = :gpk'
        expr_values = {':gpk': f'USER#{user_sub}#WSCONN'}

        if client_type:
            key_condition += ' AND GSI1SK = :gsk'
            expr_values[':gsk'] = f'TYPE#{client_type}'

        resp = self.table.query(
            IndexName='GSI1',
            KeyConditionExpression=key_condition,
            ExpressionAttributeValues=expr_values,
        )
        return resp.get('Items', [])

    def send_to_connection(self, connection_id: str, data: dict) -> bool:
        """Send a message to a WebSocket connection. Returns False if gone."""
        import json

        try:
            self.apigw.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps(data).encode('utf-8'),
            )
            return True
        except ClientError as e:
            code = e.response['Error']['Code']
            if code in ('GoneException', '410'):
                logger.info(f'Connection {connection_id} is gone, cleaning up')
                self.delete_connection(connection_id)
                return False
            raise

    def disconnect_connection(self, connection_id: str) -> None:
        """Force-disconnect a WebSocket connection."""
        try:
            self.apigw.delete_connection(ConnectionId=connection_id)
        except ClientError as e:
            code = e.response['Error']['Code']
            if code in ('GoneException', '410'):
                pass  # Already disconnected
            else:
                raise
        self.delete_connection(connection_id)
