"""EdgeQueryService - Query and metadata operations for user-profile edges."""

import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError
from models.enums import classify_conversion_likelihood
from shared_services.base_service import BaseService
from shared_services.dynamodb_types import ProfileMetadataItem
from shared_services.edge_constants import encode_profile_id

logger = logging.getLogger(__name__)


class EdgeQueryService(BaseService):
    """Manages query and metadata operations on edges."""

    def __init__(self, table, dynamodb_resource=None):
        super().__init__()
        self.table = table
        self._dynamodb_resource_override = dynamodb_resource

    @property
    def _dynamodb_resource(self):
        if self._dynamodb_resource_override is None:
            self._dynamodb_resource_override = boto3.resource('dynamodb')
        return self._dynamodb_resource_override

    def get_connections_by_status(self, user_id: str, status: str | None = None) -> dict[str, Any]:
        """Get user connections, optionally filtered by status."""
        try:
            edges = self._query_all_gsi1_edges(user_id, status) if status else self._query_all_user_edges(user_id)

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
            logger.error('DynamoDB error in get_connections_by_status: %s', e)
            raise ExternalServiceError(
                message='Failed to get connections', service='DynamoDB', original_error=str(e)
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
            logger.error('DynamoDB error in check_exists: %s', e)
            raise ExternalServiceError(
                message='Failed to check edge existence', service='DynamoDB', original_error=str(e)
            ) from e

    def query_all_edges(self, user_id: str) -> list[dict]:
        """Public accessor for querying all edges for a user."""
        return self._query_all_user_edges(user_id)

    def get_profile_metadata(self, profile_id: str) -> ProfileMetadataItem:
        """Fetch profile metadata from DynamoDB."""
        try:
            response = self.table.get_item(Key={'PK': f'PROFILE#{profile_id}', 'SK': '#METADATA'})
            return response.get('Item', {})
        except Exception as e:
            logger.warning('Failed to fetch profile metadata: %s', e)
            return {}

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
        for i in range(0, len(profile_ids), 100):
            chunk = profile_ids[i : i + 100]
            keys = [{'PK': f'PROFILE#{pid}', 'SK': '#METADATA'} for pid in chunk]
            try:
                response = dynamodb.batch_get_item(RequestItems={table_name: {'Keys': keys}})
                for item in response.get('Responses', {}).get(table_name, []):
                    pid = item.get('PK', '').replace('PROFILE#', '')
                    results[pid] = item
                unprocessed = response.get('UnprocessedKeys', {})
                while unprocessed.get(table_name):
                    response = dynamodb.batch_get_item(RequestItems=unprocessed)
                    for item in response.get('Responses', {}).get(table_name, []):
                        pid = item.get('PK', '').replace('PROFILE#', '')
                        results[pid] = item
                    unprocessed = response.get('UnprocessedKeys', {})
            except Exception as e:
                logger.warning('Batch profile metadata fetch failed for chunk: %s', e)
        return results

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
            'tags': edge_item.get('tags', []),
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
