"""EdgeOpportunityService - Opportunity tagging and stage management for edges."""

import logging
import re
import time
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ServiceError, ValidationError
from shared_services.base_service import BaseService
from shared_services.edge_constants import OPPORTUNITY_STAGES

logger = logging.getLogger(__name__)

# Bounded retry on optimistic-concurrency conflicts. Without a ceiling, a
# contended edge can burn the entire Lambda budget retrying. 3 attempts with
# 50/100/200ms backoff gives ~350ms worst case, well under the handler SLA.
MAX_RETRIES = 3
BACKOFF_BASE_MS = 50


class OptimisticConcurrencyError(ServiceError):
    """Raised after MAX_RETRIES conditional-check failures on the same key."""

    def __init__(self, message: str = 'Concurrent modification could not be resolved', field: str | None = None):
        details = {'field': field} if field else None
        super().__init__(message, code='OPTIMISTIC_CONCURRENCY', details=details)


class EdgeOpportunityService(BaseService):
    """Manages opportunity-related operations on edges."""

    def __init__(self, table, queries_svc):
        super().__init__()
        self.table = table
        self._queries_svc = queries_svc

    _BASE64URL_RE = re.compile(r'^[A-Za-z0-9_\-]+=*$')

    def _apply_with_retry(self, key: dict, build_update):
        """Run an optimistic-concurrency update with bounded retry.

        ``build_update`` is a callable that reads the current edge item and
        returns a 4-tuple ``(update_expr, condition_expr, expr_attr_values, result)``
        or raises ``ValidationError``. Returns ``result`` on success.

        Retries ``MAX_RETRIES`` times on ``ConditionalCheckFailedException`` with
        exponential backoff (50ms, 100ms, 200ms). After exhaustion raises
        ``OptimisticConcurrencyError``.
        """
        for attempt in range(MAX_RETRIES):
            response = self.table.get_item(Key=key)
            edge = response.get('Item', {})
            update_expr, condition_expr, expr_values, result = build_update(edge)
            try:
                self.table.update_item(
                    Key=key,
                    UpdateExpression=update_expr,
                    ConditionExpression=condition_expr,
                    ExpressionAttributeValues=expr_values,
                )
                return result
            except ClientError as e:
                if e.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                    raise
                if attempt == MAX_RETRIES - 1:
                    logger.warning(
                        'Optimistic concurrency exhausted for key=%s after %s attempts',
                        key,
                        MAX_RETRIES,
                    )
                    raise OptimisticConcurrencyError(field='opportunityId') from e
                backoff_s = (BACKOFF_BASE_MS * (2**attempt)) / 1000
                logger.info(
                    'Optimistic concurrency retry %s/%s after %.3fs for key=%s',
                    attempt + 1,
                    MAX_RETRIES,
                    backoff_s,
                    key,
                )
                time.sleep(backoff_s)
        # Unreachable: loop always returns or raises.
        raise RuntimeError('apply_with_retry exited without result')

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

        key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}

        def _build(edge):
            opps = list(edge.get('opportunities', []))
            previous_updated = edge.get('updatedAt')
            if any(o.get('opportunityId') == opportunity_id for o in opps):
                raise ValidationError('Connection already tagged to this opportunity', field='opportunityId')
            opps.append({'opportunityId': opportunity_id, 'stage': stage})
            current_time = datetime.now(UTC).isoformat()
            condition = 'updatedAt = :prev' if previous_updated else 'attribute_not_exists(updatedAt)'
            values = {':opps': opps, ':updated': current_time}
            if previous_updated:
                values[':prev'] = previous_updated
            return (
                'SET opportunities = :opps, updatedAt = :updated',
                condition,
                values,
                {'success': True, 'profileId': profile_id, 'opportunityId': opportunity_id, 'stage': stage},
            )

        try:
            return self._apply_with_retry(key, _build)
        except (ValidationError, OptimisticConcurrencyError):
            raise
        except ClientError as e:
            logger.error('DynamoDB error in tag_connection_to_opportunity: %s', e)
            raise ExternalServiceError(
                message='Failed to tag connection', service='DynamoDB', original_error=str(e)
            ) from e

    def untag_connection_from_opportunity(self, user_id: str, profile_id: str, opportunity_id: str) -> dict[str, Any]:
        """Remove a connection's tag from an opportunity.

        Uses optimistic concurrency to prevent lost updates from concurrent requests.
        """
        self._validate_profile_id_encoded(profile_id)
        key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}

        def _build(edge):
            opps = edge.get('opportunities', [])
            previous_updated = edge.get('updatedAt')
            filtered = [o for o in opps if o.get('opportunityId') != opportunity_id]
            if len(filtered) == len(opps):
                raise ValidationError('Connection not tagged to this opportunity', field='opportunityId')
            current_time = datetime.now(UTC).isoformat()
            condition = 'updatedAt = :prev' if previous_updated else 'attribute_not_exists(updatedAt)'
            values = {':opps': filtered, ':updated': current_time}
            if previous_updated:
                values[':prev'] = previous_updated
            return (
                'SET opportunities = :opps, updatedAt = :updated',
                condition,
                values,
                {'success': True, 'profileId': profile_id, 'opportunityId': opportunity_id},
            )

        try:
            return self._apply_with_retry(key, _build)
        except (ValidationError, OptimisticConcurrencyError):
            raise
        except ClientError as e:
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

        key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id}'}

        def _build(edge):
            opps = [dict(o) for o in edge.get('opportunities', [])]
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
            values = {':opps': opps, ':updated': current_time}
            if previous_updated:
                values[':prev'] = previous_updated
            return (
                'SET opportunities = :opps, updatedAt = :updated',
                condition,
                values,
                {
                    'success': True,
                    'profileId': profile_id,
                    'opportunityId': opportunity_id,
                    'oldStage': old_stage,
                    'newStage': new_stage,
                },
            )

        try:
            return self._apply_with_retry(key, _build)
        except (ValidationError, OptimisticConcurrencyError):
            raise
        except ClientError as e:
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
