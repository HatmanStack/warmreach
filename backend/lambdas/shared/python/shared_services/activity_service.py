"""ActivityService - Query activity timeline records from DynamoDB."""

import base64
import json
import logging
from typing import Any

from shared_services.base_service import BaseService

logger = logging.getLogger(__name__)


class ActivityService(BaseService):
    """Service for querying activity timeline records."""

    def __init__(self, table):
        super().__init__()
        self.table = table

    def get_activity_timeline(
        self,
        user_id: str,
        event_type: str | None = None,
        event_types: list[str] | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """Query activity records with pagination, event type, and date range filtering."""
        # Clamp limit to [1, 100]
        limit = max(1, min(100, limit))

        # Build query params
        query_params: dict[str, Any] = {
            'ScanIndexForward': False,
            'Limit': limit,
        }

        # Build key condition based on date range
        expr_values: dict[str, Any] = {':pk': f'USER#{user_id}'}

        if start_date and end_date:
            key_cond = 'PK = :pk AND SK BETWEEN :sk_start AND :sk_end'
            expr_values[':sk_start'] = f'ACTIVITY#{start_date}'
            expr_values[':sk_end'] = f'ACTIVITY#{end_date}\xff'
        elif start_date:
            key_cond = 'PK = :pk AND SK BETWEEN :sk_start AND :sk_end_max'
            expr_values[':sk_start'] = f'ACTIVITY#{start_date}'
            expr_values[':sk_end_max'] = 'ACTIVITY#\xff'
        elif end_date:
            key_cond = 'PK = :pk AND SK BETWEEN :sk_min AND :sk_end'
            expr_values[':sk_min'] = 'ACTIVITY#'
            expr_values[':sk_end'] = f'ACTIVITY#{end_date}\xff'
        else:
            key_cond = 'PK = :pk AND begins_with(SK, :sk_prefix)'
            expr_values[':sk_prefix'] = 'ACTIVITY#'

        query_params['KeyConditionExpression'] = key_cond
        query_params['ExpressionAttributeValues'] = expr_values

        # Event type filter (post-query)
        if event_type:
            query_params['FilterExpression'] = '#evt = :event_type'
            query_params['ExpressionAttributeNames'] = {'#evt': 'eventType'}
            expr_values[':event_type'] = event_type
        elif event_types:
            placeholders = [f':et{i}' for i in range(len(event_types))]
            query_params['FilterExpression'] = f'#evt IN ({", ".join(placeholders)})'
            query_params['ExpressionAttributeNames'] = {'#evt': 'eventType'}
            for i, et in enumerate(event_types):
                expr_values[f':et{i}'] = et

        # Cursor pagination
        if cursor:
            try:
                decoded = json.loads(base64.urlsafe_b64decode(cursor))
                query_params['ExclusiveStartKey'] = decoded
            except Exception:
                logger.warning('Invalid pagination cursor, ignoring')

        response = self.table.query(**query_params)

        # Format items
        activities = []
        for item in response.get('Items', []):
            activities.append(
                {
                    'eventType': item['eventType'],
                    'timestamp': item['timestamp'],
                    'metadata': item.get('metadata', {}),
                }
            )

        # Encode next cursor
        next_cursor = None
        last_key = response.get('LastEvaluatedKey')
        if last_key:
            next_cursor = base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()

        return {
            'success': True,
            'activities': activities,
            'nextCursor': next_cursor,
            'count': len(activities),
        }
