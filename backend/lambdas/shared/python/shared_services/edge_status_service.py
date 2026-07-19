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
        self,
        user_id: str,
        profile_id: str,
        status: str,
        added_at: str | None = None,
        messages: list | None = None,
        provenance: dict | None = None,
    ) -> dict[str, Any]:
        """Create or update edge status (idempotent upsert).

        The forward edge is written with an UPDATE (not a full-item PUT) so a
        status transition does not clobber durable attributes set earlier in the
        pipeline — tags, notes, messages, relationshipScore, and the search
        ``provenance`` (source/company/role/location) recorded when the contact
        was first surfaced. ``provenance`` values are written with if_not_exists
        so the original "why surfaced" context survives all the way to ``ally``.
        """
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            serializer = TypeSerializer()
            table_name = self.table.table_name

            # Forward edge (USER#|PROFILE#) — UPDATE preserves unnamed attributes.
            # GSI1SK encodes the status, so it must be rewritten every transition.
            fwd_set = [
                'GSI1PK = :gsi1pk',
                'GSI1SK = :gsi1sk',
                '#status = :status',
                'addedAt = if_not_exists(addedAt, :added)',
                'updatedAt = :updated',
            ]
            fwd_names = {'#status': 'status'}
            # DynamoDB AttributeValue map: entries take different shapes ({'S':..},
            # {'L':..}, serializer output), so annotate the value type broadly.
            fwd_values: dict[str, Any] = {
                ':gsi1pk': {'S': f'USER#{user_id}'},
                ':gsi1sk': {'S': f'STATUS#{status}#PROFILE#{profile_id_b64}'},
                ':status': {'S': status},
                ':added': {'S': added_at or current_time},
                ':updated': {'S': current_time},
            }
            # Replace messages only when explicitly provided; otherwise seed [] on
            # first write and preserve any existing conversation on later upserts.
            if messages is not None:
                fwd_set.append('messages = :messages')
                fwd_values[':messages'] = serializer.serialize(messages)
            else:
                fwd_set.append('messages = if_not_exists(messages, :emptyMessages)')
                fwd_values[':emptyMessages'] = {'L': []}
            if status == 'processed':
                fwd_set.append('processedAt = :processedAt')
                fwd_values[':processedAt'] = {'S': current_time}
            # Search provenance: write once, keep across transitions. Alias every
            # key via ExpressionAttributeNames to avoid DynamoDB reserved words
            # (e.g. "source").
            if provenance:
                for i, (key, val) in enumerate(provenance.items()):
                    if val in (None, ''):
                        continue
                    name_ph = f'#pv{i}'
                    val_ph = f':pv{i}'
                    fwd_set.append(f'{name_ph} = if_not_exists({name_ph}, {val_ph})')
                    fwd_names[name_ph] = key
                    fwd_values[val_ph] = serializer.serialize(val)

            try:
                self._dynamodb_client.transact_write_items(
                    TransactItems=[
                        {
                            'Update': {
                                'TableName': table_name,
                                'Key': {
                                    'PK': {'S': f'USER#{user_id}'},
                                    'SK': {'S': f'PROFILE#{profile_id_b64}'},
                                },
                                'UpdateExpression': 'SET ' + ', '.join(fwd_set),
                                'ExpressionAttributeNames': fwd_names,
                                'ExpressionAttributeValues': fwd_values,
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
                logger.error('DynamoDB error in upsert_status: %s', e)
            raise ExternalServiceError(
                message='Failed to upsert edge', service='DynamoDB', original_error=str(e)
            ) from e
