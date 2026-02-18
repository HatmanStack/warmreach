"""EdgeService - Business logic for edge management operations."""

import base64
import logging
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

# Shared layer imports (from /opt/python via Lambda Layer)
from errors.exceptions import ExternalServiceError, ValidationError
from models.enums import classify_conversion_likelihood
from shared_services.base_service import BaseService

logger = logging.getLogger(__name__)

# Statuses that trigger RAGStack ingestion
INGESTION_TRIGGER_STATUSES = {'outgoing', 'ally', 'followed'}

# Maximum messages stored per edge
MAX_MESSAGES_PER_EDGE = 100


class EdgeService(BaseService):
    """
    Service class for managing edges between users and profiles.

    Handles all business logic for edge operations, with AWS clients
    injected via constructor for testability.
    """

    def __init__(
        self,
        table,
        ragstack_endpoint: str = '',
        ragstack_api_key: str = '',
        ragstack_client=None,
        ingestion_service=None,
    ):
        """
        Initialize EdgeService with injected dependencies.

        Args:
            table: DynamoDB Table resource
            ragstack_endpoint: RAGStack GraphQL API endpoint URL
            ragstack_api_key: RAGStack API key for authentication
            ragstack_client: Optional pre-built RAGStackClient instance
            ingestion_service: Optional pre-built IngestionService instance
        """
        super().__init__()
        self.table = table
        self.ragstack_endpoint = ragstack_endpoint
        self.ragstack_api_key = ragstack_api_key
        self.ragstack_client = ragstack_client
        self.ingestion_service = ingestion_service

    def upsert_status(
        self, user_id: str, profile_id: str, status: str, added_at: str | None = None, messages: list | None = None
    ) -> dict[str, Any]:
        """
        Create or update edge status (idempotent upsert).

        Args:
            user_id: User ID from Cognito
            profile_id: LinkedIn profile URL/identifier
            status: Edge status (possible, outgoing, ally, etc.)
            added_at: Optional timestamp override
            messages: Optional initial messages list

        Returns:
            dict with success status and profile ID

        Raises:
            ExternalServiceError: On DynamoDB failures
        """
        try:
            profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()
            current_time = datetime.now(UTC).isoformat()

            # Create user-to-profile edge
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

            # Write both edges — put forward edge, update reverse edge with attempts counter.
            # Compensating delete on reverse-edge failure prevents partial state.
            self.table.put_item(Item=user_profile_edge)
            try:
                self.table.update_item(
                    Key={
                        'PK': f'PROFILE#{profile_id_b64}',
                        'SK': f'USER#{user_id}',
                    },
                    UpdateExpression='SET addedAt = if_not_exists(addedAt, :added), #status = :status, lastAttempt = :lastAttempt, updatedAt = :updated, attempts = if_not_exists(attempts, :zero) + :inc',
                    ExpressionAttributeNames={'#status': 'status'},
                    ExpressionAttributeValues={
                        ':added': added_at or current_time,
                        ':status': status,
                        ':lastAttempt': current_time,
                        ':updated': current_time,
                        ':zero': 0,
                        ':inc': 1,
                    },
                )
            except Exception:
                logger.error(
                    'Reverse edge write failed, rolling back forward edge',
                    extra={'user_id': user_id, 'profile_id': profile_id_b64},
                )
                self.table.delete_item(Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'})
                raise

            # Trigger RAGStack ingestion for established relationships
            ragstack_ingested = False
            ragstack_error = None

            if status in INGESTION_TRIGGER_STATUSES:
                ingestion_result = self._trigger_ragstack_ingestion(profile_id_b64, user_id)
                if ingestion_result.get('success'):
                    ragstack_ingested = True
                    self._update_ingestion_flag(user_id, profile_id_b64, current_time)
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
            logger.error(f'DynamoDB error in upsert_status: {e}')
            raise ExternalServiceError(
                message='Failed to upsert edge', service='DynamoDB', original_error=str(e)
            ) from e

    def add_message(
        self, user_id: str, profile_id_b64: str, message: str, message_type: str = 'outbound'
    ) -> dict[str, Any]:
        """
        Add a message to an existing edge.

        Args:
            user_id: User ID
            profile_id_b64: Base64-encoded profile ID
            message: Message content
            message_type: Message type (outbound/inbound)

        Returns:
            dict with success status

        Raises:
            ValidationError: If message is empty
            ExternalServiceError: On DynamoDB failures
        """
        if not message or not message.strip():
            raise ValidationError('Message is required', field='message')

        try:
            current_time = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'}

            # Check current message count to enforce cap
            existing = self.table.get_item(Key=key, ProjectionExpression='messages')
            current_messages = existing.get('Item', {}).get('messages', [])
            if isinstance(current_messages, list) and len(current_messages) >= MAX_MESSAGES_PER_EDGE:
                # Trim oldest messages to make room
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
        """
        Replace the full messages list on an edge (used after scraping a conversation).

        Args:
            user_id: User ID from Cognito
            profile_id: LinkedIn profile identifier (plain, not base64)
            messages: List of message dicts {content, timestamp, type}

        Returns:
            dict with success status and message count
        """
        try:
            profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()
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
        """
        Get user connections, optionally filtered by status.

        Args:
            user_id: User ID
            status: Optional status filter

        Returns:
            dict with connections list and count
        """
        try:
            if status:
                response = self.table.query(
                    IndexName='GSI1',
                    KeyConditionExpression='GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
                    ExpressionAttributeValues={':pk': f'USER#{user_id}', ':sk': f'STATUS#{status}#'},
                )
            else:
                response = self.table.query(
                    KeyConditionExpression='PK = :pk AND begins_with(SK, :sk)',
                    ExpressionAttributeValues={':pk': f'USER#{user_id}', ':sk': 'PROFILE#'},
                )

            connections = []
            for edge_item in response.get('Items', []):
                profile_id = edge_item['SK'].replace('PROFILE#', '')
                if not profile_id:
                    continue

                profile_data = self._get_profile_metadata(profile_id)
                connection = self._format_connection_object(profile_id, profile_data, edge_item)
                connections.append(connection)

            return {'success': True, 'connections': connections, 'count': len(connections)}

        except ClientError as e:
            logger.error(f'DynamoDB error in get_connections_by_status: {e}')
            raise ExternalServiceError(
                message='Failed to get connections', service='DynamoDB', original_error=str(e)
            ) from e

    def get_messages(self, user_id: str, profile_id_b64: str) -> dict[str, Any]:
        """
        Get message history for an edge.

        Args:
            user_id: User ID
            profile_id_b64: Base64-encoded profile ID

        Returns:
            dict with formatted messages list
        """
        try:
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
        """
        Check if an edge exists between user and profile.

        Args:
            user_id: User ID
            profile_id: LinkedIn profile identifier (plain, not base64)

        Returns:
            dict with exists flag and edge data if exists
        """
        try:
            profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()
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

    # =========================================================================
    # RAGStack proxy operations
    # =========================================================================

    def ragstack_search(self, query: str, max_results: int = 100) -> dict[str, Any]:
        """Search RAGStack for matching profiles."""
        if not self.ragstack_client:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        results = self.ragstack_client.search(query, max_results)
        return {'results': results, 'totalResults': len(results)}

    def ragstack_ingest(
        self,
        profile_id: str,
        markdown_content: str,
        metadata: dict[str, Any],
        user_id: str,
    ) -> dict[str, Any]:
        """Ingest a profile document into RAGStack."""
        if not self.ingestion_service:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        metadata['user_id'] = user_id
        return self.ingestion_service.ingest_profile(profile_id, markdown_content, metadata)

    def ragstack_status(self, document_id: str) -> dict[str, Any]:
        """Get ingestion status for a document."""
        if not self.ragstack_client:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        return self.ragstack_client.get_document_status(document_id)

    def ragstack_scrape_start(
        self, profile_id: str, cookies: str, scrape_config: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Start a RAGStack scrape job for a LinkedIn profile."""
        if not self.ragstack_client:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        config = scrape_config or {}
        url = f'https://www.linkedin.com/in/{profile_id}/'
        return self.ragstack_client.start_scrape(
            url=url,
            cookies=cookies,
            max_pages=config.get('maxPages', 5),
            max_depth=config.get('maxDepth', 1),
            scope=config.get('scope', 'SUBPAGES'),
            include_patterns=config.get('includePatterns'),
            scrape_mode=config.get('scrapeMode', 'FULL'),
        )

    def ragstack_scrape_status(self, job_id: str) -> dict[str, Any]:
        """Get the status of a RAGStack scrape job."""
        if not self.ragstack_client:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        return self.ragstack_client.get_scrape_job(job_id)

    # =========================================================================
    # Private helper methods
    # =========================================================================

    def _get_profile_metadata(self, profile_id: str) -> dict:
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

        # Use enum-based conversion likelihood
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
        }

    def _calculate_conversion_likelihood(self, profile_data: dict, edge_item: dict) -> str:
        """
        Calculate conversion likelihood using enum classification.

        Returns string enum value ('high', 'medium', 'low').
        """
        # Map edge_item fields to expected format
        edge_data = {'date_added': edge_item.get('addedAt'), 'connection_attempts': edge_item.get('attempts', 0)}

        # Map profile_data fields
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

        try:
            profile_data = self._get_profile_metadata(profile_id_b64)
            if not profile_data:
                return {'success': False, 'error': 'Profile metadata not found'}

            profile_data['profile_id'] = profile_id_b64

            # Generate markdown
            try:
                from utils.profile_markdown import generate_profile_markdown

                markdown_content = generate_profile_markdown(profile_data)
            except ImportError as e:
                logger.error(f'Failed to import profile_markdown: {e}')
                return {'success': False, 'error': 'Markdown generator module not available'}
            except Exception as e:
                logger.error(f'Error generating markdown: {e}')
                return {'success': False, 'error': f'Markdown generation failed: {e}'}

            # Call RAGStack directly via shared client
            from shared_services.ingestion_service import IngestionService
            from shared_services.ragstack_client import RAGStackClient

            client = RAGStackClient(self.ragstack_endpoint, self.ragstack_api_key)
            ingestion_svc = IngestionService(client)
            result = ingestion_svc.ingest_profile(
                profile_id=profile_id_b64,
                markdown_content=markdown_content,
                metadata={'user_id': user_id, 'source': 'edge_processing'},
            )

            if result.get('status') in ('uploaded', 'indexed'):
                return {'success': True, 'status': result['status'], 'documentId': result.get('documentId')}
            else:
                return {'success': False, 'error': result.get('error', 'Ingestion failed')}

        except Exception as e:
            logger.error(f'Error triggering RAGStack ingestion: {e}')
            return {'success': False, 'error': str(e)}

    def _update_ingestion_flag(self, user_id: str, profile_id_b64: str, timestamp: str) -> None:
        """Update edge with RAGStack ingestion status."""
        try:
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'},
                UpdateExpression='SET ragstack_ingested = :ingested, ragstack_ingested_at = :ingested_at',
                ExpressionAttributeValues={':ingested': True, ':ingested_at': timestamp},
            )
        except Exception as e:
            logger.warning(f'Failed to update ingestion flag: {e}')
