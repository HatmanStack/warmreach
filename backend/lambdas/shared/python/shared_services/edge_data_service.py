"""EdgeDataService - Thin facade over focused edge sub-services.

Module-level constants and encode_profile_id are re-exported from
edge_constants for backward compatibility. All external consumers and
sub-services can continue importing from this module.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from shared_services.base_service import BaseService
from shared_services.dynamodb_types import ProfileMetadataItem
from shared_services.edge_constants import (  # noqa: F401
    INGESTION_TRIGGER_STATUSES,
    MAX_MESSAGES_PER_EDGE,
    MAX_NOTE_LENGTH,
    MAX_NOTES_PER_EDGE,
    OPPORTUNITY_OUTCOMES,
    OPPORTUNITY_STAGES,
    encode_profile_id,
)
from shared_services.edge_ingestion_service import EdgeIngestionService
from shared_services.edge_message_service import EdgeMessageService
from shared_services.edge_note_service import EdgeNoteService
from shared_services.edge_query_service import EdgeQueryService
from shared_services.edge_status_service import EdgeStatusService

logger = logging.getLogger(__name__)


class EdgeDataService(BaseService):
    """Facade that delegates to focused edge sub-services.

    The public API is identical to the original monolithic class. All consumers
    continue importing from this module without changes.
    """

    def __init__(
        self,
        table,
        ragstack_endpoint: str = '',
        ragstack_api_key: str = '',
        ragstack_client=None,
        ingestion_service=None,
        dynamodb_client=None,
    ):
        super().__init__()
        self.table = table
        self.ragstack_endpoint = ragstack_endpoint
        self.ragstack_api_key = ragstack_api_key
        self.ragstack_client = ragstack_client
        self.ingestion_service = ingestion_service

        self._ingestion_svc = EdgeIngestionService(
            table, ragstack_endpoint, ragstack_api_key, ragstack_client, ingestion_service
        )
        self._status_svc = EdgeStatusService(table, self._ingestion_svc, dynamodb_client)
        self._messages_svc = EdgeMessageService(table)
        self._notes_svc = EdgeNoteService(table)
        self._queries_svc = EdgeQueryService(table)

    # ---- Status operations (delegated to EdgeStatusService) ----

    def upsert_status(
        self, user_id: str, profile_id: str, status: str, added_at: str | None = None, messages: list | None = None
    ) -> dict[str, Any]:
        return self._status_svc.upsert_status(user_id, profile_id, status, added_at, messages)

    # ---- Message operations (delegated to EdgeMessageService) ----

    def add_message(
        self, user_id: str, profile_id: str, message: str, message_type: str = 'outbound'
    ) -> dict[str, Any]:
        return self._messages_svc.add_message(user_id, profile_id, message, message_type)

    def update_messages(self, user_id: str, profile_id: str, messages: list) -> dict[str, Any]:
        return self._messages_svc.update_messages(user_id, profile_id, messages)

    def get_messages(self, user_id: str, profile_id: str) -> dict[str, Any]:
        return self._messages_svc.get_messages(user_id, profile_id)

    # ---- Note operations (delegated to EdgeNoteService) ----

    def add_note(self, user_id: str, profile_id: str, content: str) -> dict[str, Any]:
        return self._notes_svc.add_note(user_id, profile_id, content)

    def update_note(self, user_id: str, profile_id: str, note_id: str, content: str) -> dict[str, Any]:
        return self._notes_svc.update_note(user_id, profile_id, note_id, content)

    def delete_note(self, user_id: str, profile_id: str, note_id: str) -> dict[str, Any]:
        return self._notes_svc.delete_note(user_id, profile_id, note_id)

    # ---- Query operations (delegated to EdgeQueryService) ----

    def get_connections_by_status(self, user_id: str, status: str | None = None) -> dict[str, Any]:
        return self._queries_svc.get_connections_by_status(user_id, status)

    def check_exists(self, user_id: str, profile_id: str) -> dict[str, Any]:
        return self._queries_svc.check_exists(user_id, profile_id)

    def query_all_edges(self, user_id: str) -> list[dict]:
        return self._queries_svc.query_all_edges(user_id)

    def get_profile_metadata(self, profile_id: str) -> ProfileMetadataItem:
        return self._queries_svc.get_profile_metadata(profile_id)

    def batch_get_profile_metadata(self, profile_ids: list[str]) -> dict[str, ProfileMetadataItem]:
        return self._queries_svc.batch_get_profile_metadata(profile_ids)

    # ---- Ingestion operations (delegated to EdgeIngestionService) ----

    def is_recently_ingested(self, profile_id: str) -> bool:
        return self._ingestion_svc.is_recently_ingested(profile_id)

    def _trigger_ragstack_ingestion(self, profile_id_b64: str, user_id: str) -> dict:
        return self._ingestion_svc.trigger_ragstack_ingestion(profile_id_b64, user_id)

    def _update_ingestion_flag(
        self, user_id: str, profile_id_b64: str, timestamp: str, document_id: str | None = None
    ) -> None:
        return self._ingestion_svc.update_ingestion_flag(user_id, profile_id_b64, timestamp, document_id)

    # ---- Opportunity methods (remain in facade, not yet extracted) ----

    @staticmethod
    def _validate_profile_id_encoded(profile_id: str) -> None:
        """Validate that profile_id looks like a base64url-encoded string."""
        if '/' in profile_id or profile_id.startswith('http'):
            raise ValidationError(
                'profile_id must be base64url-encoded, got a raw URL or path',
                field='profileId',
            )

    def tag_connection_to_opportunity(
        self, user_id: str, profile_id: str, opportunity_id: str, stage: str = 'identified'
    ) -> dict[str, Any]:
        """Tag a connection to an opportunity with an initial stage."""
        self._validate_profile_id_encoded(profile_id)
        if stage not in OPPORTUNITY_STAGES:
            raise ValidationError(f'Invalid stage: {stage}. Must be one of: {", ".join(OPPORTUNITY_STAGES)}')

        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])

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
        """Remove a connection's tag from an opportunity."""
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
        """Update a connection's stage within an opportunity."""
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
            edges = self._queries_svc.query_all_edges(user_id)

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
