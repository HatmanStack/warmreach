"""EdgeOpportunityService - Opportunity tagging and stage management for edges."""

import logging
import re
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from shared_services.base_service import BaseService
from shared_services.edge_constants import OPPORTUNITY_STAGES

logger = logging.getLogger(__name__)


class EdgeOpportunityService(BaseService):
    """Manages opportunity-related operations on edges."""

    def __init__(self, table, queries_svc):
        super().__init__()
        self.table = table
        self._queries_svc = queries_svc

    _BASE64URL_RE = re.compile(r'^[A-Za-z0-9_\-]+=*$')

    @classmethod
    def _validate_profile_id_encoded(cls, profile_id: str) -> None:
        """Validate that profile_id is a base64url-encoded string."""
        if not profile_id or not cls._BASE64URL_RE.fullmatch(profile_id):
            raise ValidationError(
                'profile_id must be base64url-encoded',
                field='profileId',
            )

    def tag_connection_to_opportunity(
        self, user_id: str, profile_id: str, opportunity_id: str, stage: str = 'identified'
    ) -> dict[str, Any]:
        """Tag a connection to an opportunity with an initial stage.

        Uses optimistic concurrency: the write is conditioned on updatedAt matching
        the value read, preventing duplicate tags from concurrent requests.
        """
        self._validate_profile_id_encoded(profile_id)
        if stage not in OPPORTUNITY_STAGES:
            raise ValidationError(f'Invalid stage: {stage}. Must be one of: {", ".join(OPPORTUNITY_STAGES)}')

        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])
            previous_updated = edge.get('updatedAt')

            if any(o.get('opportunityId') == opportunity_id for o in opps):
                raise ValidationError('Connection already tagged to this opportunity', field='opportunityId')

            opps.append({'opportunityId': opportunity_id, 'stage': stage})
            current_time = datetime.now(UTC).isoformat()

            condition = 'updatedAt = :prev' if previous_updated else 'attribute_not_exists(updatedAt)'
            condition_values = {':opps': opps, ':updated': current_time}
            if previous_updated:
                condition_values[':prev'] = previous_updated

            self.table.update_item(
                Key=key,
                UpdateExpression='SET opportunities = :opps, updatedAt = :updated',
                ConditionExpression=condition,
                ExpressionAttributeValues=condition_values,
            )

            return {'success': True, 'profileId': profile_id, 'opportunityId': opportunity_id, 'stage': stage}

        except ValidationError:
            raise
        except ClientError as e:
            if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                raise ValidationError('Concurrent modification detected, please retry', field='opportunityId') from e
            logger.error('DynamoDB error in tag_connection_to_opportunity: %s', e)
            raise ExternalServiceError(
                message='Failed to tag connection', service='DynamoDB', original_error=str(e)
            ) from e

    def untag_connection_from_opportunity(self, user_id: str, profile_id: str, opportunity_id: str) -> dict[str, Any]:
        """Remove a connection's tag from an opportunity.

        Uses optimistic concurrency to prevent lost updates from concurrent requests.
        """
        self._validate_profile_id_encoded(profile_id)
        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])
            previous_updated = edge.get('updatedAt')

            filtered = [o for o in opps if o.get('opportunityId') != opportunity_id]
            if len(filtered) == len(opps):
                raise ValidationError('Connection not tagged to this opportunity', field='opportunityId')

            current_time = datetime.now(UTC).isoformat()
            condition = 'updatedAt = :prev' if previous_updated else 'attribute_not_exists(updatedAt)'
            condition_values = {':opps': filtered, ':updated': current_time}
            if previous_updated:
                condition_values[':prev'] = previous_updated

            self.table.update_item(
                Key=key,
                UpdateExpression='SET opportunities = :opps, updatedAt = :updated',
                ConditionExpression=condition,
                ExpressionAttributeValues=condition_values,
            )

            return {'success': True, 'profileId': profile_id, 'opportunityId': opportunity_id}

        except ValidationError:
            raise
        except ClientError as e:
            if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                raise ValidationError('Concurrent modification detected, please retry', field='opportunityId') from e
            logger.error('DynamoDB error in untag_connection_from_opportunity: %s', e)
            raise ExternalServiceError(
                message='Failed to untag connection', service='DynamoDB', original_error=str(e)
            ) from e

    def update_connection_stage(
        self, user_id: str, profile_id: str, opportunity_id: str, new_stage: str
    ) -> dict[str, Any]:
        """Update a connection's stage within an opportunity.

        Uses optimistic concurrency to prevent lost updates from concurrent requests.
        """
        self._validate_profile_id_encoded(profile_id)
        if new_stage not in OPPORTUNITY_STAGES:
            raise ValidationError(f'Invalid stage: {new_stage}. Must be one of: {", ".join(OPPORTUNITY_STAGES)}')

        try:
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            opps = edge.get('opportunities', [])
            previous_updated = edge.get('updatedAt')

            old_stage = None
            for opp in opps:
                if opp.get('opportunityId') == opportunity_id:
                    old_stage = opp['stage']
                    opp['stage'] = new_stage
                    break

            if old_stage is None:
                raise ValidationError('Connection not tagged to this opportunity', field='opportunityId')

            current_time = datetime.now(UTC).isoformat()
            condition = 'updatedAt = :prev' if previous_updated else 'attribute_not_exists(updatedAt)'
            condition_values = {':opps': opps, ':updated': current_time}
            if previous_updated:
                condition_values[':prev'] = previous_updated

            self.table.update_item(
                Key=key,
                UpdateExpression='SET opportunities = :opps, updatedAt = :updated',
                ConditionExpression=condition,
                ExpressionAttributeValues=condition_values,
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
            if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                raise ValidationError('Concurrent modification detected, please retry', field='opportunityId') from e
            logger.error('DynamoDB error in update_connection_stage: %s', e)
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
            logger.error('DynamoDB error in get_opportunity_connections: %s', e)
            raise ExternalServiceError(
                message='Failed to get opportunity connections', service='DynamoDB', original_error=str(e)
            ) from e
