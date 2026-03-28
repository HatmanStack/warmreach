"""EdgeStatusService - Status management for user-profile edges."""

import logging
from datetime import UTC, datetime
from typing import Any

import boto3
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError
from shared_services.base_service import BaseService
from shared_services.edge_constants import INGESTION_TRIGGER_STATUSES, encode_profile_id

logger = logging.getLogger(__name__)


class EdgeStatusService(BaseService):
    """Manages edge status creation and updates."""

    def __init__(self, table, ingestion_service=None, dynamodb_client=None):
        super().__init__()
        self.table = table
        self._dynamodb_client_override = dynamodb_client
        self._ingestion = ingestion_service

    @property
    def _dynamodb_client(self):
        if self._dynamodb_client_override is None:
            self._dynamodb_client_override = boto3.client('dynamodb')
        return self._dynamodb_client_override

    def upsert_status(
        self, user_id: str, profile_id: str, status: str, added_at: str | None = None, messages: list | None = None
    ) -> dict[str, Any]:
        """Create or update edge status (idempotent upsert)."""
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()

            user_profile_edge = {
                'PK': f'USER#{user_id}',
                'SK': f'PROFILE#{profile_id_b64}',
                'status': status,
                'addedAt': added_at or current_time,
                'updatedAt': current_time,
                'messages': messages or [],
                'GSI1PK': f'USER#{user_id}',
                'GSI1SK': f'STATUS#{status}#PROFILE#{profile_id_b64}',
            }
            if status == 'processed':
                user_profile_edge['processedAt'] = current_time

            serializer = TypeSerializer()
            serialized_item = {k: serializer.serialize(v) for k, v in user_profile_edge.items()}
            table_name = self.table.table_name

            try:
                self._dynamodb_client.transact_write_items(
                    TransactItems=[
                        {
                            'Put': {
                                'TableName': table_name,
                                'Item': serialized_item,
                            },
                        },
                        {
                            'Update': {
                                'TableName': table_name,
                                'Key': {
                                    'PK': {'S': f'PROFILE#{profile_id_b64}'},
                                    'SK': {'S': f'USER#{user_id}'},
                                },
                                'UpdateExpression': 'SET addedAt = if_not_exists(addedAt, :added), #status = :status, lastAttempt = :lastAttempt, updatedAt = :updated, attempts = if_not_exists(attempts, :zero) + :inc',
                                'ExpressionAttributeNames': {'#status': 'status'},
                                'ExpressionAttributeValues': {
                                    ':added': {'S': added_at or current_time},
                                    ':status': {'S': status},
                                    ':lastAttempt': {'S': current_time},
                                    ':updated': {'S': current_time},
                                    ':zero': {'N': '0'},
                                    ':inc': {'N': '1'},
                                },
                            },
                        },
                    ]
                )
            except ClientError as e:
                if e.response['Error']['Code'] == 'TransactionCanceledException':
                    reasons = e.response.get('CancellationReasons', [])
                    logger.error(
                        'Edge transaction cancelled',
                        extra={
                            'user_id': user_id,
                            'profile_id': profile_id_b64,
                            'cancellation_reasons': reasons,
                        },
                    )
                raise

            ragstack_ingested = False
            ragstack_error = None

            if status in INGESTION_TRIGGER_STATUSES and self._ingestion:
                ingestion_result = self._ingestion.trigger_ragstack_ingestion(profile_id_b64, user_id)
                if ingestion_result.get('success'):
                    ragstack_ingested = True
                    self._ingestion.update_ingestion_flag(
                        user_id,
                        profile_id_b64,
                        current_time,
                        document_id=ingestion_result.get('documentId'),
                    )
                else:
                    ragstack_error = ingestion_result.get('error')

            return {
                'success': True,
                'message': 'Edge upserted successfully',
                'profileId': profile_id_b64,
                'status': status,
                'ragstack_ingested': ragstack_ingested,
                'ragstack_error': ragstack_error,
            }

        except ClientError as e:
            if e.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
                logger.error(f'DynamoDB error in upsert_status: {e}')
            raise ExternalServiceError(
                message='Failed to upsert edge', service='DynamoDB', original_error=str(e)
            ) from e
