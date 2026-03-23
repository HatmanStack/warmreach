"""EdgeDataService - Edge CRUD operations for DynamoDB."""

import base64
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from models.enums import classify_conversion_likelihood
from shared_services.base_service import BaseService
from shared_services.dynamodb_types import ProfileMetadataItem

logger = logging.getLogger(__name__)


def encode_profile_id(profile_id: str) -> str:
    """URL-safe base64 encode a profile ID for use as a DynamoDB key component."""
    return base64.urlsafe_b64encode(profile_id.encode()).decode()


# Statuses that trigger RAGStack ingestion
INGESTION_TRIGGER_STATUSES = {'outgoing', 'ally', 'followed'}

# Maximum messages stored per edge
MAX_MESSAGES_PER_EDGE = 100

# Maximum notes stored per edge
MAX_NOTES_PER_EDGE = 50

# Maximum note content length
MAX_NOTE_LENGTH = 1000

# Opportunity pipeline stages
OPPORTUNITY_STAGES = ['identified', 'reached_out', 'replied', 'met', 'outcome']

# Opportunity outcome sub-statuses
OPPORTUNITY_OUTCOMES = ['won', 'lost', 'stalled']


class EdgeDataService(BaseService):
    """Service for edge CRUD operations between users and profiles."""

    def __init__(
        self,
        table,
        ragstack_endpoint: str = '',
        ragstack_api_key: str = '',
        ragstack_client=None,
        ingestion_service=None,
    ):
        super().__init__()
        self.table = table
        # Eager construction is intentional: boto3 clients are cheap and benefit
        # from Lambda warm-container reuse. Lazy init would add complexity for
        # negligible savings.
        self._dynamodb_resource = boto3.resource('dynamodb')
        self._dynamodb_client = boto3.client('dynamodb')
        self.ragstack_endpoint = ragstack_endpoint
        self.ragstack_api_key = ragstack_api_key
        self.ragstack_client = ragstack_client
        self.ingestion_service = ingestion_service

    @staticmethod
    def _to_dynamodb_item(item: dict) -> dict:
        """Convert a high-level Python dict to DynamoDB JSON format."""
        from boto3.dynamodb.types import TypeSerializer

        serializer = TypeSerializer()
        return {k: serializer.serialize(v) for k, v in item.items()}

    def upsert_status(
        self, user_id: str, profile_id: str, status: str, added_at: str | None = None, messages: list | None = None
    ) -> dict[str, Any]:
        """Create or update edge status (atomic dual-edge write via TransactWriteItems)."""
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

            table_name = self.table.table_name

            self._dynamodb_client.transact_write_items(
                TransactItems=[
                    {
                        'Put': {
                            'TableName': table_name,
                            'Item': self._to_dynamodb_item(user_profile_edge),
                        }
                    },
                    {
                        'Update': {
                            'TableName': table_name,
                            'Key': self._to_dynamodb_item(
                                {
                                    'PK': f'PROFILE#{profile_id_b64}',
                                    'SK': f'USER#{user_id}',
                                }
                            ),
                            'UpdateExpression': 'SET addedAt = if_not_exists(addedAt, :added), #status = :status, lastAttempt = :lastAttempt, updatedAt = :updated, attempts = if_not_exists(attempts, :zero) + :inc',
                            'ExpressionAttributeNames': {'#status': 'status'},
                            'ExpressionAttributeValues': self._to_dynamodb_item(
                                {
                                    ':added': added_at or current_time,
                                    ':status': status,
                                    ':lastAttempt': current_time,
                                    ':updated': current_time,
                                    ':zero': 0,
                                    ':inc': 1,
                                }
                            ),
                        }
                    },
                ]
            )

            ragstack_ingested = False
            ragstack_error = None

            if status in INGESTION_TRIGGER_STATUSES:
                ingestion_result = self._trigger_ragstack_ingestion(profile_id_b64, user_id)
                if ingestion_result.get('success'):
                    ragstack_ingested = True
                    self._update_ingestion_flag(
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
            error_code = e.response.get('Error', {}).get('Code', '')
            if error_code == 'TransactionCanceledException':
                logger.error(
                    'Atomic edge transaction cancelled',
                    extra={'user_id': user_id, 'profile_id': profile_id, 'reasons': str(e)},
                )
            else:
                logger.error(f'DynamoDB error in upsert_status: {e}')
            raise ExternalServiceError(
                message='Failed to upsert edge', service='DynamoDB', original_error=str(e)
            ) from e

    def add_message(
        self, user_id: str, profile_id: str, message: str, message_type: str = 'outbound'
    ) -> dict[str, Any]:
        """Add a message to an existing edge."""
        if not message or not message.strip():
            raise ValidationError('Message is required', field='message')

        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'}

            existing = self.table.get_item(Key=key, ProjectionExpression='messages')
            current_messages = existing.get('Item', {}).get('messages', [])
            if isinstance(current_messages, list) and len(current_messages) >= MAX_MESSAGES_PER_EDGE:
                trimmed = current_messages[-(MAX_MESSAGES_PER_EDGE - 1) :]
                trimmed.append({'content': message, 'timestamp': current_time, 'type': message_type})
                self.table.update_item(
                    Key=key,
                    UpdateExpression='SET messages = :msgs, updatedAt = :updated_at',
                    ExpressionAttributeValues={':msgs': trimmed, ':updated_at': current_time},
                )
            else:
                self.table.update_item(
                    Key=key,
                    UpdateExpression='SET messages = list_append(if_not_exists(messages, :empty_list), :message), updatedAt = :updated_at',
                    ExpressionAttributeValues={
                        ':message': [{'content': message, 'timestamp': current_time, 'type': message_type}],
                        ':empty_list': [],
                        ':updated_at': current_time,
                    },
                )

            return {'success': True, 'message': 'Message added successfully', 'profileId': profile_id_b64}

        except ClientError as e:
            logger.error(f'DynamoDB error in add_message: {e}')
            raise ExternalServiceError(
                message='Failed to add message', service='DynamoDB', original_error=str(e)
            ) from e

    def update_messages(self, user_id: str, profile_id: str, messages: list) -> dict[str, Any]:
        """Replace the full messages list on an edge."""
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            trimmed = messages[-MAX_MESSAGES_PER_EDGE:] if messages else []

            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'},
                UpdateExpression='SET messages = :msgs, updatedAt = :updated',
                ExpressionAttributeValues={
                    ':msgs': trimmed,
                    ':updated': current_time,
                },
            )

            return {'success': True, 'messageCount': len(trimmed), 'profileId': profile_id_b64}

        except ClientError as e:
            logger.error(f'DynamoDB error in update_messages: {e}')
            raise ExternalServiceError(
                message='Failed to update messages', service='DynamoDB', original_error=str(e)
            ) from e

    def get_connections_by_status(self, user_id: str, status: str | None = None) -> dict[str, Any]:
        """Get user connections, optionally filtered by status."""
        try:
            edges = self._query_all_gsi1_edges(user_id, status) if status else self._query_all_user_edges(user_id)

            # Collect all profile IDs and batch-fetch metadata in one call
            profile_ids = []
            for edge_item in edges:
                profile_id = edge_item['SK'].replace('PROFILE#', '')
                if profile_id:
                    profile_ids.append(profile_id)

            profile_metadata = self.batch_get_profile_metadata(profile_ids) if profile_ids else {}

            connections = []
            for edge_item in edges:
                profile_id = edge_item['SK'].replace('PROFILE#', '')
                if not profile_id:
                    continue

                profile_data = profile_metadata.get(profile_id, {})
                connection = self._format_connection_object(profile_id, profile_data, edge_item)
                connections.append(connection)

            return {'success': True, 'connections': connections, 'count': len(connections)}

        except ClientError as e:
            logger.error(f'DynamoDB error in get_connections_by_status: {e}')
            raise ExternalServiceError(
                message='Failed to get connections', service='DynamoDB', original_error=str(e)
            ) from e

    def get_messages(self, user_id: str, profile_id: str) -> dict[str, Any]:
        """Get message history for an edge."""
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'})

            if 'Item' not in response:
                return {'success': True, 'messages': [], 'count': 0}

            edge_item = response['Item']
            raw_messages = edge_item.get('messages', [])
            formatted_messages = self._format_messages(raw_messages, profile_id_b64, edge_item)

            return {'success': True, 'messages': formatted_messages, 'count': len(formatted_messages)}

        except ClientError as e:
            logger.error(f'DynamoDB error in get_messages: {e}')
            raise ExternalServiceError(
                message='Failed to get messages', service='DynamoDB', original_error=str(e)
            ) from e

    def check_exists(self, user_id: str, profile_id: str) -> dict[str, Any]:
        """Check if an edge exists between user and profile."""
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'})

            edge_exists = 'Item' in response
            edge_data = response.get('Item', {}) if edge_exists else {}

            return {
                'success': True,
                'exists': edge_exists,
                'profileId': profile_id_b64,
                'edge_data': {
                    'status': edge_data.get('status'),
                    'addedAt': edge_data.get('addedAt'),
                    'updatedAt': edge_data.get('updatedAt'),
                    'processedAt': edge_data.get('processedAt'),
                }
                if edge_exists
                else None,
            }

        except ClientError as e:
            logger.error(f'DynamoDB error in check_exists: {e}')
            raise ExternalServiceError(
                message='Failed to check edge existence', service='DynamoDB', original_error=str(e)
            ) from e

    def _query_all_user_edges(self, user_id: str) -> list[dict]:
        """Query all edge items for a user, paginating through all results."""
        edges: list[dict] = []
        params: dict[str, Any] = {
            'KeyConditionExpression': 'PK = :pk AND begins_with(SK, :sk)',
            'ExpressionAttributeValues': {':pk': f'USER#{user_id}', ':sk': 'PROFILE#'},
        }
        while True:
            response = self.table.query(**params)
            edges.extend(response.get('Items', []))
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
            params['ExclusiveStartKey'] = last_key
        return edges

    def _query_all_gsi1_edges(self, user_id: str, status: str) -> list[dict]:
        """Query all edge items for a user+status via GSI1, paginating through all results."""
        edges: list[dict] = []
        params: dict[str, Any] = {
            'IndexName': 'GSI1',
            'KeyConditionExpression': 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
            'ExpressionAttributeValues': {':pk': f'USER#{user_id}', ':sk': f'STATUS#{status}#'},
        }
        while True:
            response = self.table.query(**params)
            edges.extend(response.get('Items', []))
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
            params['ExclusiveStartKey'] = last_key
        return edges

    def query_all_edges(self, user_id: str) -> list[dict]:
        """Public accessor for querying all edges for a user. Delegates to _query_all_user_edges."""
        return self._query_all_user_edges(user_id)

    def get_profile_metadata(self, profile_id: str) -> ProfileMetadataItem:
        """Public accessor for profile metadata. Delegates to _get_profile_metadata."""
        return self._get_profile_metadata(profile_id)

    def batch_get_profile_metadata(self, profile_ids: list[str]) -> dict[str, ProfileMetadataItem]:
        """Fetch profile metadata for multiple profiles using BatchGetItem.

        Returns a dict mapping profile_id -> metadata. Missing profiles are omitted.
        DynamoDB BatchGetItem supports up to 100 keys per call.

        Uses the DynamoDB service resource's batch_get_item (not the low-level
        client) so responses are auto-deserialized to Python types.
        """
        results: dict[str, ProfileMetadataItem] = {}
        if not profile_ids:
            return results

        table_name = self.table.table_name
        dynamodb = self._dynamodb_resource
        # Process in chunks of 100 (BatchGetItem limit)
        for i in range(0, len(profile_ids), 100):
            chunk = profile_ids[i : i + 100]
            keys = [{'PK': f'PROFILE#{pid}', 'SK': '#METADATA'} for pid in chunk]
            try:
                response = dynamodb.batch_get_item(RequestItems={table_name: {'Keys': keys}})
                for item in response.get('Responses', {}).get(table_name, []):
                    pid = item.get('PK', '').replace('PROFILE#', '')
                    results[pid] = item
                # Handle unprocessed keys with retry
                unprocessed = response.get('UnprocessedKeys', {})
                while unprocessed.get(table_name):
                    response = dynamodb.batch_get_item(RequestItems=unprocessed)
                    for item in response.get('Responses', {}).get(table_name, []):
                        pid = item.get('PK', '').replace('PROFILE#', '')
                        results[pid] = item
                    unprocessed = response.get('UnprocessedKeys', {})
            except Exception as e:
                logger.warning(f'Batch profile metadata fetch failed for chunk: {e}')
        return results

    def add_note(self, user_id: str, profile_id: str, content: str) -> dict[str, Any]:
        """Add a note to an existing edge."""
        if not content or not content.strip():
            raise ValidationError('Note content is required', field='content')
        if len(content) > MAX_NOTE_LENGTH:
            raise ValidationError(f'Note content exceeds {MAX_NOTE_LENGTH} characters', field='content')

        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'}

            note_id = str(uuid.uuid4())

            note = {
                'id': note_id,
                'content': content,
                'timestamp': current_time,
                'updatedAt': current_time,
            }

            self.table.update_item(
                Key=key,
                UpdateExpression='SET notes = list_append(if_not_exists(notes, :empty_list), :note), updatedAt = :updated_at',
                ConditionExpression='attribute_not_exists(notes) OR size(notes) < :max_notes',
                ExpressionAttributeValues={
                    ':note': [note],
                    ':empty_list': [],
                    ':updated_at': current_time,
                    ':max_notes': MAX_NOTES_PER_EDGE,
                },
            )

            return {'success': True, 'noteId': note_id, 'profileId': profile_id_b64}

        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                raise ValidationError(
                    f'Maximum of {MAX_NOTES_PER_EDGE} notes per connection reached',
                    field='notes',
                ) from e
            logger.error(f'DynamoDB error in add_note: {e}')
            raise ExternalServiceError(message='Failed to add note', service='DynamoDB', original_error=str(e)) from e

    def update_note(self, user_id: str, profile_id: str, note_id: str, content: str) -> dict[str, Any]:
        """Update an existing note on an edge."""
        if not content or not content.strip():
            raise ValidationError('Note content is required', field='content')
        if len(content) > MAX_NOTE_LENGTH:
            raise ValidationError(f'Note content exceeds {MAX_NOTE_LENGTH} characters', field='content')

        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'}

            response = self.table.get_item(Key=key, ProjectionExpression='notes')
            notes = response.get('Item', {}).get('notes', [])

            found = False
            for note in notes:
                if note.get('id') == note_id:
                    note['content'] = content
                    note['updatedAt'] = current_time
                    found = True
                    break

            if not found:
                raise ValidationError('Note not found', field='noteId')

            self.table.update_item(
                Key=key,
                UpdateExpression='SET notes = :notes, updatedAt = :updated',
                ExpressionAttributeValues={':notes': notes, ':updated': current_time},
            )

            return {'success': True, 'noteId': note_id, 'profileId': profile_id_b64}

        except ValidationError:
            raise
        except ClientError as e:
            logger.error(f'DynamoDB error in update_note: {e}')
            raise ExternalServiceError(
                message='Failed to update note', service='DynamoDB', original_error=str(e)
            ) from e

    def delete_note(self, user_id: str, profile_id: str, note_id: str) -> dict[str, Any]:
        """Delete a note from an edge."""
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'}

            response = self.table.get_item(Key=key, ProjectionExpression='notes')
            notes = response.get('Item', {}).get('notes', [])

            filtered = [n for n in notes if n.get('id') != note_id]
            if len(filtered) == len(notes):
                raise ValidationError('Note not found', field='noteId')

            self.table.update_item(
                Key=key,
                UpdateExpression='SET notes = :notes, updatedAt = :updated',
                ExpressionAttributeValues={':notes': filtered, ':updated': current_time},
            )

            return {'success': True, 'noteId': note_id, 'profileId': profile_id_b64}

        except ValidationError:
            raise
        except ClientError as e:
            logger.error(f'DynamoDB error in delete_note: {e}')
            raise ExternalServiceError(
                message='Failed to delete note', service='DynamoDB', original_error=str(e)
            ) from e

    # =========================================================================
    # Opportunity stage management
    # =========================================================================

    @staticmethod
    def _validate_profile_id_encoded(profile_id: str) -> None:
        """Validate that profile_id looks like a base64url-encoded string.

        Raises ValidationError if the value looks like a raw URL or contains
        characters that are not valid in base64url encoding.
        """
        if '/' in profile_id or profile_id.startswith('http'):
            raise ValidationError(
                'profile_id must be base64url-encoded, got a raw URL or path',
                field='profileId',
            )

    def tag_connection_to_opportunity(
        self, user_id: str, profile_id: str, opportunity_id: str, stage: str = 'identified'
    ) -> dict[str, Any]:
        """Tag a connection to an opportunity with an initial stage.

        Args:
            user_id: The user who owns the edge.
            profile_id: Base64url-encoded profile ID (must be pre-encoded by the caller).
            opportunity_id: The opportunity to tag.
            stage: Initial pipeline stage (default: 'identified').
        """
        self._validate_profile_id_encoded(profile_id)
        if stage not in OPPORTUNITY_STAGES:
            raise ValidationError(f'Invalid stage: {stage}. Must be one of: {", ".join(OPPORTUNITY_STAGES)}')

        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])

            # Check for duplicate
            if any(o.get('opportunityId') == opportunity_id for o in opps):
                raise ValidationError('Connection already tagged to this opportunity', field='opportunityId')

            opps.append({'opportunityId': opportunity_id, 'stage': stage})
            current_time = datetime.now(UTC).isoformat()

            self.table.update_item(
                Key=key,
                UpdateExpression='SET opportunities = :opps, updatedAt = :updated',
                ExpressionAttributeValues={':opps': opps, ':updated': current_time},
            )

            return {'success': True, 'profileId': profile_id, 'opportunityId': opportunity_id, 'stage': stage}

        except ValidationError:
            raise
        except ClientError as e:
            logger.error(f'DynamoDB error in tag_connection_to_opportunity: {e}')
            raise ExternalServiceError(
                message='Failed to tag connection', service='DynamoDB', original_error=str(e)
            ) from e

    def untag_connection_from_opportunity(self, user_id: str, profile_id: str, opportunity_id: str) -> dict[str, Any]:
        """Remove a connection's tag from an opportunity.

        Args:
            user_id: The user who owns the edge.
            profile_id: Base64url-encoded profile ID (must be pre-encoded by the caller).
            opportunity_id: The opportunity to untag.
        """
        self._validate_profile_id_encoded(profile_id)
        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])

            filtered = [o for o in opps if o.get('opportunityId') != opportunity_id]
            if len(filtered) == len(opps):
                raise ValidationError('Connection not tagged to this opportunity', field='opportunityId')

            current_time = datetime.now(UTC).isoformat()
            self.table.update_item(
                Key=key,
                UpdateExpression='SET opportunities = :opps, updatedAt = :updated',
                ExpressionAttributeValues={':opps': filtered, ':updated': current_time},
            )

            return {'success': True, 'profileId': profile_id, 'opportunityId': opportunity_id}

        except ValidationError:
            raise
        except ClientError as e:
            logger.error(f'DynamoDB error in untag_connection_from_opportunity: {e}')
            raise ExternalServiceError(
                message='Failed to untag connection', service='DynamoDB', original_error=str(e)
            ) from e

    def update_connection_stage(
        self, user_id: str, profile_id: str, opportunity_id: str, new_stage: str
    ) -> dict[str, Any]:
        """Update a connection's stage within an opportunity.

        Args:
            user_id: The user who owns the edge.
            profile_id: Base64url-encoded profile ID (must be pre-encoded by the caller).
            opportunity_id: The opportunity whose stage to update.
            new_stage: The new pipeline stage.
        """
        self._validate_profile_id_encoded(profile_id)
        if new_stage not in OPPORTUNITY_STAGES:
            raise ValidationError(f'Invalid stage: {new_stage}. Must be one of: {", ".join(OPPORTUNITY_STAGES)}')

        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])

            old_stage = None
            for opp in opps:
                if opp.get('opportunityId') == opportunity_id:
                    old_stage = opp['stage']
                    opp['stage'] = new_stage
                    break

            if old_stage is None:
                raise ValidationError('Connection not tagged to this opportunity', field='opportunityId')

            current_time = datetime.now(UTC).isoformat()
            self.table.update_item(
                Key=key,
                UpdateExpression='SET opportunities = :opps, updatedAt = :updated',
                ExpressionAttributeValues={':opps': opps, ':updated': current_time},
            )

            return {
                'success': True,
                'profileId': profile_id,
                'opportunityId': opportunity_id,
                'oldStage': old_stage,
                'newStage': new_stage,
            }

        except ValidationError:
            raise
        except ClientError as e:
            logger.error(f'DynamoDB error in update_connection_stage: {e}')
            raise ExternalServiceError(
                message='Failed to update connection stage', service='DynamoDB', original_error=str(e)
            ) from e

    def get_opportunity_connections(self, user_id: str, opportunity_id: str) -> dict[str, Any]:
        """Get all connections tagged to an opportunity, grouped by stage."""
        try:
            edges = self._query_all_user_edges(user_id)

            stages: dict[str, list] = {stage: [] for stage in OPPORTUNITY_STAGES}
            total = 0

            for edge in edges:
                opps = edge.get('opportunities', [])
                for opp in opps:
                    if opp.get('opportunityId') == opportunity_id:
                        stage = opp.get('stage', 'identified')
                        profile_id = edge.get('SK', '').replace('PROFILE#', '')
                        connection_info = {
                            'profileId': profile_id,
                            'firstName': edge.get('first_name', ''),
                            'lastName': edge.get('last_name', ''),
                            'position': edge.get('position', ''),
                            'company': edge.get('company', ''),
                            'stage': stage,
                        }
                        if stage in stages:
                            stages[stage].append(connection_info)
                        total += 1
                        break

            return {'success': True, 'stages': stages, 'totalCount': total}

        except ClientError as e:
            logger.error(f'DynamoDB error in get_opportunity_connections: {e}')
            raise ExternalServiceError(
                message='Failed to get opportunity connections', service='DynamoDB', original_error=str(e)
            ) from e

    # =========================================================================
    # Private helper methods
    # =========================================================================

    def is_recently_ingested(self, profile_id: str) -> bool:
        """Check if this profile has been ingested within 30 days."""
        return self._get_ingest_state(profile_id) is not None

    def _get_ingest_state(self, profile_id: str) -> dict | None:
        """Get the ingest state for a profile if ingested within 30 days."""
        try:
            response = self.table.get_item(
                Key={'PK': f'PROFILE#{profile_id}', 'SK': '#INGEST_STATE'},
            )
            item = response.get('Item')
            if not item:
                return None

            ingested_at_str = item.get('ingested_at', '')
            if not ingested_at_str:
                return None

            thirty_days_ago = datetime.now(UTC) - timedelta(days=30)
            try:
                ingested_at = datetime.fromisoformat(ingested_at_str.replace('Z', '+00:00'))
                if ingested_at > thirty_days_ago:
                    return item
                return None
            except (ValueError, TypeError):
                return None
        except Exception as e:
            logger.warning(f'Failed to check ingestion dedup for {profile_id}: {e}')
            return None

    def _update_ingest_state(self, profile_id: str, document_id: str | None = None) -> None:
        """Write a shared dedup marker at PROFILE#{id}|#INGEST_STATE with 35-day TTL."""
        try:
            timestamp = datetime.now(UTC).isoformat()
            ttl = int(time.time()) + (35 * 24 * 3600)
            update_expr = 'SET ingested_at = :ts, #ttl = :ttl'
            attr_names: dict[str, str] = {'#ttl': 'ttl'}
            attr_values: dict[str, Any] = {':ts': timestamp, ':ttl': ttl}
            if document_id:
                update_expr += ', document_id = :doc_id'
                attr_values[':doc_id'] = document_id
            self.table.update_item(
                Key={'PK': f'PROFILE#{profile_id}', 'SK': '#INGEST_STATE'},
                UpdateExpression=update_expr,
                ExpressionAttributeNames=attr_names,
                ExpressionAttributeValues=attr_values,
            )
        except Exception as e:
            logger.warning(f'Failed to update ingest state for {profile_id}: {e}')

    def _get_profile_metadata(self, profile_id: str) -> ProfileMetadataItem:
        """Fetch profile metadata from DynamoDB."""
        try:
            response = self.table.get_item(Key={'PK': f'PROFILE#{profile_id}', 'SK': '#METADATA'})
            return response.get('Item', {})
        except Exception as e:
            logger.warning(f'Failed to fetch profile metadata: {e}')
            return {}

    def _format_connection_object(self, profile_id: str, profile_data: dict, edge_item: dict) -> dict:
        """Format connection object for frontend consumption."""
        full_name = profile_data.get('name', '')
        name_parts = full_name.split(' ', 1) if full_name else ['', '']
        first_name = name_parts[0] if name_parts else ''
        last_name = name_parts[1] if len(name_parts) > 1 else ''

        messages = edge_item.get('messages', [])
        message_count = len(messages) if isinstance(messages, list) else 0

        conversion_likelihood = None
        if edge_item.get('status') == 'possible':
            conversion_likelihood = self._calculate_conversion_likelihood(profile_data, edge_item)

        return {
            'id': profile_id,
            'first_name': first_name,
            'last_name': last_name,
            'position': profile_data.get('currentTitle', ''),
            'company': profile_data.get('currentCompany', ''),
            'location': profile_data.get('currentLocation', ''),
            'headline': profile_data.get('headline', ''),
            'recent_activity': profile_data.get('summary', ''),
            'common_interests': profile_data.get('skills', []) if isinstance(profile_data.get('skills'), list) else [],
            'messages': message_count,
            'date_added': edge_item.get('addedAt', ''),
            'linkedin_url': profile_data.get('originalUrl', ''),
            'tags': profile_data.get('skills', []) if isinstance(profile_data.get('skills'), list) else [],
            'last_action_summary': edge_item.get('lastActionSummary', ''),
            'status': edge_item.get('status', ''),
            'conversion_likelihood': conversion_likelihood,
            'profile_picture_url': profile_data.get('profilePictureUrl', ''),
            'message_history': messages if isinstance(messages, list) else [],
            'notes': edge_item.get('notes', []),
            'relationship_score': edge_item.get('relationshipScore'),
            'score_breakdown': edge_item.get('scoreBreakdown'),
            'score_computed_at': edge_item.get('scoreComputedAt'),
        }

    def _calculate_conversion_likelihood(self, profile_data: dict, edge_item: dict) -> str:
        """Calculate conversion likelihood using enum classification."""
        edge_data = {'date_added': edge_item.get('addedAt'), 'connection_attempts': edge_item.get('attempts', 0)}
        profile = {'headline': profile_data.get('headline'), 'summary': profile_data.get('summary')}
        result = classify_conversion_likelihood(profile, edge_data)
        return result.value

    def _format_messages(self, raw_messages: list, profile_id: str, edge_item: dict) -> list[dict]:
        """Format raw messages for frontend consumption."""
        formatted = []

        for i, msg in enumerate(raw_messages):
            try:
                if isinstance(msg, str):
                    formatted_msg = {
                        'id': f'{profile_id}_{i}',
                        'content': msg,
                        'timestamp': edge_item.get('addedAt', ''),
                        'sender': 'user',
                    }
                elif isinstance(msg, dict):
                    sender = msg.get('sender', msg.get('type', 'user'))
                    if sender == 'outbound':
                        sender = 'user'
                    elif sender == 'inbound':
                        sender = 'connection'

                    formatted_msg = {
                        'id': msg.get('id', f'{profile_id}_{i}'),
                        'content': msg.get('content', str(msg)),
                        'timestamp': msg.get('timestamp', edge_item.get('addedAt', '')),
                        'sender': sender,
                    }
                else:
                    formatted_msg = {
                        'id': f'{profile_id}_{i}',
                        'content': str(msg),
                        'timestamp': edge_item.get('addedAt', ''),
                        'sender': 'user',
                    }

                formatted.append(formatted_msg)

            except Exception as e:
                logger.warning(f'Error formatting message {i}: {e}')
                formatted.append(
                    {
                        'id': f'{profile_id}_{i}_error',
                        'content': '[Message formatting error]',
                        'timestamp': edge_item.get('addedAt', ''),
                        'sender': 'user',
                    }
                )

        return formatted

    def _trigger_ragstack_ingestion(self, profile_id_b64: str, user_id: str) -> dict:
        """Trigger RAGStack ingestion for a profile via direct HTTP call."""
        if not self.ragstack_endpoint or not self.ragstack_api_key:
            logger.warning('RAGStack not configured, skipping ingestion')
            return {'success': False, 'error': 'RAGStack not configured'}

        if not self.ragstack_client or not self.ingestion_service:
            logger.warning('RAGStack client/ingestion service not injected, skipping ingestion')
            return {'success': False, 'error': 'RAGStack services not injected'}

        ingest_state = self._get_ingest_state(profile_id_b64)
        if ingest_state:
            logger.info(f'Skipping ingestion for {profile_id_b64}: recently ingested')
            return {
                'success': True,
                'status': 'already_ingested',
                'documentId': ingest_state.get('document_id'),
            }

        try:
            profile_data = self._get_profile_metadata(profile_id_b64)
            if not profile_data:
                return {'success': False, 'error': 'Profile metadata not found'}

            profile_data['profile_id'] = profile_id_b64

            try:
                from utils.profile_markdown import generate_profile_markdown

                markdown_content = generate_profile_markdown(profile_data)
            except ImportError as e:
                logger.error(f'Failed to import profile_markdown: {e}')
                return {'success': False, 'error': 'Markdown generator module not available'}
            except Exception as e:
                logger.error(f'Error generating markdown: {e}')
                return {'success': False, 'error': f'Markdown generation failed: {e}'}

            result = self.ingestion_service.ingest_profile(
                profile_id=profile_id_b64,
                markdown_content=markdown_content,
                metadata={'user_id': user_id, 'source': 'edge_processing'},
            )

            if result.get('status') in ('uploaded', 'indexed'):
                self._update_ingest_state(profile_id_b64, result.get('documentId'))
                return {'success': True, 'status': result['status'], 'documentId': result.get('documentId')}
            else:
                return {'success': False, 'error': result.get('error', 'Ingestion failed')}

        except Exception as e:
            logger.error(f'Error triggering RAGStack ingestion: {e}')
            return {'success': False, 'error': str(e)}

    def _update_ingestion_flag(
        self, user_id: str, profile_id_b64: str, timestamp: str, document_id: str | None = None
    ) -> None:
        """Update edge with RAGStack ingestion status."""
        try:
            update_expr = 'SET ragstack_ingested = :ingested, ragstack_ingested_at = :ingested_at'
            attr_values: dict[str, Any] = {':ingested': True, ':ingested_at': timestamp}
            if document_id:
                update_expr += ', ragstack_document_id = :doc_id'
                attr_values[':doc_id'] = document_id
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'},
                UpdateExpression=update_expr,
                ExpressionAttributeValues=attr_values,
            )
        except Exception as e:
            logger.warning(f'Failed to update ingestion flag: {e}')
