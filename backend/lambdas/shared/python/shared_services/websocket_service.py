"""WebSocket connection management service.

Provides helpers for the @connections API Gateway Management API
and DynamoDB connection tracking.
"""

import logging
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# TTL for WSCONN# rows. API Gateway caps a WebSocket connection at 24 hours, so
# 26h can never reap a connection that is still legitimately alive; the 2h
# margin absorbs clock skew and DynamoDB's own "within 48 hours of expiry"
# deletion window being best-effort.
#
# $disconnect is best-effort and is not guaranteed to fire, so without this an
# orphaned row survived indefinitely. Functionally such a row self-heals on the
# next send (GoneException -> delete_connection), but until then it makes an
# offline agent look online, and create_command then burns a rate-limit slot and
# writes a COMMAND# before failing.
WSCONN_TTL_SECONDS = 26 * 3600


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
        """Write WSCONN item to DynamoDB.

        The ``ttl`` attribute name matches the one ``COMMAND#`` items already use
        (``command_dispatch_core.COMMAND_TTL_SECONDS``); DynamoDB allows exactly
        one TTL attribute per table, so do not introduce a second name.
        """
        now = int(time.time())
        self.table.put_item(
            Item={
                'PK': f'WSCONN#{connection_id}',
                'SK': '#METADATA',
                'GSI1PK': f'USER#{user_sub}#WSCONN',
                'GSI1SK': f'TYPE#{client_type}',
                'connectionId': connection_id,
                'userSub': user_sub,
                'clientType': client_type,
                'connectedAt': now,
                'ttl': now + WSCONN_TTL_SECONDS,
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
        """Query GSI1 for a user's WebSocket connections, optionally filtered by type.

        Expired rows are filtered out. DynamoDB TTL deletion is best-effort and
        can lag by up to 48 hours, so a row past its ``ttl`` is still returned by
        the index — which makes an offline agent look online, and
        ``create_command`` then burns a rate-limit slot and writes a ``COMMAND#``
        before discovering the connection is gone. Rows written before the TTL
        attribute existed carry no ``ttl`` and are kept, since nothing is known
        about their age.
        """
        key_condition = 'GSI1PK = :gpk'
        expr_values: dict = {':gpk': f'USER#{user_sub}#WSCONN'}

        if client_type:
            key_condition += ' AND GSI1SK = :gsk'
            expr_values[':gsk'] = f'TYPE#{client_type}'

        expr_values[':now'] = int(time.time())

        resp = self.table.query(
            IndexName='GSI1',
            KeyConditionExpression=key_condition,
            FilterExpression='attribute_not_exists(#ttl) OR #ttl > :now',
            ExpressionAttributeNames={'#ttl': 'ttl'},
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
                logger.info('Connection %s is gone, cleaning up', connection_id)
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
                logger.info(
                    'Connection %s already gone during disconnect, cleaning up record',
                    connection_id,
                )
            else:
                raise
        self.delete_connection(connection_id)
