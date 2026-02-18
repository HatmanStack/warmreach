"""DynamoDBApiService - Business logic for user profile and settings operations."""

import base64
import ipaddress
import logging
import socket
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from botocore.exceptions import ClientError
from shared_services.base_service import BaseService

logger = logging.getLogger(__name__)


class DynamoDBApiService(BaseService):
    """
    Service class for user profile and settings operations.

    Handles all business logic for DynamoDB API operations, with the
    DynamoDB table injected via constructor for testability.
    """

    def __init__(self, table):
        """
        Initialize DynamoDBApiService with injected dependencies.

        Args:
            table: DynamoDB Table resource
        """
        super().__init__()
        self.table = table

    def get_user_profile(self, user_id: str) -> dict[str, Any]:
        """Fetch user profile.
        Reads from #SETTINGS first, falls back to legacy PROFILE SK.
        Returns profile-api compatible response format.
        """
        # Read from the canonical SETTINGS sort key first
        response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': '#SETTINGS'})
        item = response.get('Item')

        # Fallback to legacy PROFILE SK if #SETTINGS doesn't exist
        if not item:
            response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': 'PROFILE'})
            item = response.get('Item')

        if not item:
            # Return default profile structure
            now = datetime.now(UTC).isoformat()
            return {
                'userId': user_id,
                'email': '',
                'firstName': '',
                'lastName': '',
                'linkedin_credentials': None,
                'createdAt': now,
                'updatedAt': now,
            }

        # Build profile response (support both camelCase and snake_case field names)
        return {
            'userId': user_id,
            'email': item.get('email', ''),
            'firstName': item.get('firstName', item.get('first_name', '')),
            'lastName': item.get('lastName', item.get('last_name', '')),
            'headline': item.get('headline', ''),
            'location': item.get('location', ''),
            'company': item.get('company', ''),
            'current_position': item.get('current_position', ''),
            'summary': item.get('summary', ''),
            'interests': item.get('interests', ''),
            'linkedin_credentials': item.get('linkedin_credentials'),
            'unpublished_post_content': item.get('unpublished_post_content', ''),
            'ai_generated_ideas': item.get('ai_generated_ideas'),
            'ai_generated_research': item.get('ai_generated_research'),
            'ai_generated_post_hook': item.get('ai_generated_post_hook', ''),
            'ai_generated_post_reasoning': item.get('ai_generated_post_reasoning', ''),
            'createdAt': item.get('createdAt', item.get('created_at', '')),
            'updatedAt': item.get('updatedAt', item.get('updated_at', '')),
        }

    def update_user_settings(self, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Update user profile info and/or linkedin_credentials.
        Profile fields are stored under PK=USER#{sub}, SK=#SETTINGS.
        """
        current_time = datetime.now(UTC).isoformat()

        # Extract profile fields
        profile_updates = {}
        allowed_profile_fields = [
            'first_name',
            'last_name',
            'headline',
            'profile_url',
            'profile_picture_url',
            'location',
            'summary',
            'industry',
            'current_position',
            'company',
            'interests',
            'unpublished_post_content',
            'linkedin_credentials',
            'ai_generated_ideas',
            'ai_generated_research',
            'ai_generated_post_hook',
            'ai_generated_post_reasoning',
        ]
        for field in allowed_profile_fields:
            if field in body and body[field] is not None:
                if not self.validate_profile_field(field, body[field]):
                    logger.warning(f'Invalid value for field: {field}')
                    return {'error': f'Invalid value for field: {field}'}
                profile_updates[field] = body[field]

        logger.info('Profile updates validated', {'user_id': user_id, 'fields': list(profile_updates.keys())})

        # If any profile fields provided, upsert profile item
        if profile_updates:
            update_expr_parts = []
            expr_attr_values = {':ts': current_time}
            expr_attr_names = {}

            for k, v in profile_updates.items():
                name_key = f'#f_{k}'
                expr_attr_names[name_key] = k
                value_key = f':v_{k}'
                expr_attr_values[value_key] = v
                update_expr_parts.append(f'{name_key} = {value_key}')

            update_expression = 'SET ' + ', '.join(
                update_expr_parts + ['updated_at = :ts', 'created_at = if_not_exists(created_at, :ts)']
            )

            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': '#SETTINGS'},
                UpdateExpression=update_expression,
                ExpressionAttributeNames=expr_attr_names,
                ExpressionAttributeValues=expr_attr_values,
            )
        else:
            logger.debug('No profile fields provided for update')

        return {'success': True}

    def create_bad_contact_profile(self, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Create a bad contact profile with processed status."""
        profile_id = body.get('profileId')
        if not profile_id:
            return {'error': 'profileId is required'}
        profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()

        updates = body.get('updates', {})
        current_time = datetime.now(UTC).isoformat()

        profile_metadata = {
            'PK': f'PROFILE#{profile_id_b64}',
            'SK': '#METADATA',
            'originalUrl': body.get('profileId', ''),
            'createdAt': updates.get('addedAt', current_time),
            'updatedAt': current_time,
            'name': updates.get('name', ''),
            'headline': updates.get('headline', ''),
            'summary': updates.get('summary', ''),
            'profilePictureUrl': updates.get('profilePictureUrl', ''),
            'currentCompany': updates.get('currentCompany', ''),
            'currentTitle': updates.get('currentTitle', ''),
            'currentLocation': updates.get('currentLocation', ''),
            'employmentType': updates.get('employmentType', ''),
            'workExperience': updates.get('workExperience', []),
            'education': updates.get('education', []),
            'skills': updates.get('skills', []),
            'fulltext': updates.get('fulltext', ''),
            'evaluated': True,
        }

        self.table.put_item(Item=profile_metadata)

        logger.info(
            f'Created/updated bad contact profile metadata (evaluated=True): {profile_id_b64} for user: {user_id}'
        )

        return {
            'message': 'Bad contact profile metadata updated successfully',
            'profileId': profile_id_b64,
            'evaluated': True,
        }

    def update_profile_picture(self, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Update only the profilePictureUrl field on an existing profile metadata record."""
        profile_id = body.get('profileId')
        if not profile_id:
            return {'error': 'profileId is required'}

        picture_url = body.get('profilePictureUrl', '')
        if picture_url and (len(picture_url) > 500 or not self._is_safe_url(picture_url)):
            return {'error': 'Invalid profilePictureUrl'}

        profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()

        self.table.update_item(
            Key={'PK': f'PROFILE#{profile_id_b64}', 'SK': '#METADATA'},
            UpdateExpression='SET profilePictureUrl = :url, updatedAt = :now',
            ExpressionAttributeValues={
                ':url': picture_url,
                ':now': datetime.now(UTC).isoformat(),
            },
        )

        return {'message': 'Profile picture updated', 'profileId': profile_id_b64}

    def get_user_settings(self, user_id: str) -> dict[str, Any] | None:
        """Get user settings item (e.g., encrypted linkedin_credentials).
        Key: PK=USER#<sub>, SK=#SETTINGS
        """
        response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': '#SETTINGS'})
        return response.get('Item')

    def get_profile_metadata(self, profile_id_b64: str) -> dict[str, Any] | None:
        """Get profile metadata by base64-encoded profile ID."""
        try:
            response = self.table.get_item(Key={'PK': f'PROFILE#{profile_id_b64}', 'SK': '#METADATA'})
            return response.get('Item')
        except ClientError as e:
            logger.error(f'Error getting profile metadata: {str(e)}')
            return None

    def validate_profile_field(self, field: str, value: Any) -> bool:
        """Validate profile field values for type and length constraints."""
        validators = {
            'first_name': lambda v: isinstance(v, str) and 1 <= len(v) <= 100,
            'last_name': lambda v: isinstance(v, str) and 1 <= len(v) <= 100,
            'headline': lambda v: isinstance(v, str) and len(v) <= 220,
            'profile_url': lambda v: isinstance(v, str) and len(v) <= 500 and self._is_safe_url(v),
            'profile_picture_url': lambda v: isinstance(v, str) and len(v) <= 500 and self._is_safe_url(v),
            'location': lambda v: isinstance(v, str) and len(v) <= 100,
            'summary': lambda v: isinstance(v, str) and len(v) <= 2600,
            'industry': lambda v: isinstance(v, str) and len(v) <= 100,
            'current_position': lambda v: isinstance(v, str) and len(v) <= 100,
            'company': lambda v: isinstance(v, str) and len(v) <= 100,
            'interests': lambda v: isinstance(v, (str, list)) and len(str(v)) <= 1000,
            'unpublished_post_content': lambda v: isinstance(v, str) and len(v) <= 3000,
            'linkedin_credentials': lambda v: isinstance(v, (str, dict)),
            'ai_generated_ideas': lambda v: isinstance(v, (str, list, dict)),
            'ai_generated_research': lambda v: isinstance(v, (str, list, dict)),
            'ai_generated_post_hook': lambda v: isinstance(v, str) and len(v) <= 500,
            'ai_generated_post_reasoning': lambda v: isinstance(v, str) and len(v) <= 2000,
        }
        validator = validators.get(field)
        if not validator:
            logger.warning(f'Rejected unknown profile field: {field}')
            return False
        return validator(value)

    def _is_safe_url(self, url: str) -> bool:
        """Validate URL is safe (HTTPS, non-private IP, valid hostname)."""
        try:
            parsed = urlparse(url)
            if parsed.scheme != 'https':
                return False
            hostname = parsed.hostname
            if not hostname:
                return False
            try:
                addr_info = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                for _, _, _, _, sockaddr in addr_info:
                    ip = ipaddress.ip_address(sockaddr[0])
                    if ip.is_private or ip.is_reserved or ip.is_loopback or ip.is_link_local:
                        return False
            except (socket.gaierror, ValueError) as e:
                logger.warning(f"DNS resolution failed for hostname '{hostname}': {e}")
                return False
            return True
        except Exception:
            return False
