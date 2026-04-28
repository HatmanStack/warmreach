"""DynamoDBApiService - Business logic for user profile and settings operations."""

import ipaddress
import logging
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from botocore.exceptions import ClientError
from shared_services.base_service import BaseService
from shared_services.edge_data_service import encode_profile_id

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
            'unpublished_post_content': item.get('unpublished_post_content', ''),
            'ai_generated_ideas': item.get('ai_generated_ideas'),
            'ai_generated_research': item.get('ai_generated_research'),
            'ai_generated_post_hook': item.get('ai_generated_post_hook', ''),
            'ai_generated_post_reasoning': item.get('ai_generated_post_reasoning', ''),
            'createdAt': item.get('createdAt', item.get('created_at', '')),
            'updatedAt': item.get('updatedAt', item.get('updated_at', '')),
        }

    def update_user_settings(self, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Update user profile info.
        Profile fields are stored under PK=USER#{sub}, SK=#SETTINGS.

        LinkedIn credentials are NOT accepted here. They live exclusively
        on-device in the desktop client (encrypted with libsodium Sealbox)
        and are never transmitted to or stored in DynamoDB. Any
        linkedin_credentials field in the request body is silently
        ignored — see allowed_profile_fields below.
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
            # 'linkedin_credentials' intentionally excluded — credentials live
            # on-device in the desktop client only (Sealbox-encrypted).
            'ai_generated_ideas',
            'ai_generated_research',
            'ai_generated_post_hook',
            'ai_generated_post_reasoning',
            'timezone',
            'digest_opted_out',
            'onboarding_completed',
            'onboarding_step',
            'comment_concierge_mode',
        ]
        for field in allowed_profile_fields:
            if field in body and body[field] is not None:
                if not self.validate_profile_field(field, body[field]):
                    logger.warning('Invalid value for field: %s', field)
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

    VALID_SOURCES = frozenset({'linkedin', 'github', 'twitter', 'meetup', 'email', 'manual'})
    VALID_CONTACT_STATUSES = frozenset({'processed', 'ally', 'possible'})

    def create_bad_contact_profile(self, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Create a bad contact profile with processed status.

        Also supports manual contact creation when source/status are provided.
        """
        profile_id = body.get('profileId')
        if not profile_id:
            return {'error': 'profileId is required'}

        source = body.get('source', 'linkedin')
        if source not in self.VALID_SOURCES:
            return {'error': 'Invalid source value'}

        status = body.get('status', 'processed')
        if status not in self.VALID_CONTACT_STATUSES:
            return {'error': 'Invalid status value'}

        profile_id_b64 = encode_profile_id(profile_id)

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
            'source': source,
        }

        self.table.put_item(Item=profile_metadata)

        logger.info(
            'Created/updated bad contact profile metadata (evaluated=True): %s for user: %s', profile_id_b64, user_id
        )

        return {
            'message': 'Bad contact profile metadata updated successfully',
            'profileId': profile_id_b64,
            'evaluated': True,
            'status': status,
        }

    def update_profile_picture(self, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Update only the profilePictureUrl field on an existing profile metadata record."""
        profile_id = body.get('profileId')
        if not profile_id:
            return {'error': 'profileId is required'}

        picture_url = body.get('profilePictureUrl', '')
        if picture_url and (len(picture_url) > 500 or not self._is_safe_url(picture_url)):
            return {'error': 'Invalid profilePictureUrl'}

        profile_id_b64 = encode_profile_id(profile_id)

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
        """Get user settings item.
        Key: PK=USER#<sub>, SK=#SETTINGS
        """
        response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': '#SETTINGS'})
        return response.get('Item')

    def get_profile_metadata(self, profile_id_b64: str) -> dict[str, Any] | None:
        """Get profile metadata by base64-encoded profile ID."""
        try:
            response = self.table.get_item(Key={'PK': f'PROFILE#{profile_id_b64}', 'SK': '#METADATA'})
            return response.get('Item')
        except ClientError:
            logger.exception('Error getting profile metadata')
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
            'ai_generated_ideas': lambda v: isinstance(v, (str, list, dict)),
            'ai_generated_research': lambda v: isinstance(v, (str, list, dict)),
            'ai_generated_post_hook': lambda v: isinstance(v, str) and len(v) <= 500,
            'ai_generated_post_reasoning': lambda v: isinstance(v, str) and len(v) <= 2000,
            'timezone': lambda v: isinstance(v, str) and len(v) <= 50,
            'digest_opted_out': lambda v: isinstance(v, bool),
            'comment_concierge_mode': lambda v: isinstance(v, str) and v in {'automated', 'manual', 'off'},
        }
        validator = validators.get(field)
        if not validator:
            logger.warning('Rejected unknown profile field: %s', field)
            return False
        return validator(value)

    def get_daily_scrape_count(self, user_id: str, date: str) -> dict[str, Any]:
        """Get daily scrape count for a user on a given date."""
        try:
            response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': f'#DAILY_SCRAPE_COUNT#{date}'})
            item = response.get('Item')
            return {'count': item.get('count', 0) if item else 0}
        except ClientError as e:
            logger.error('Error getting daily scrape count: %s', e)
            return {'count': 0}

    def increment_daily_scrape_count(self, user_id: str, date: str) -> dict[str, Any]:
        """Atomically increment daily scrape count. Sets 48h TTL on creation."""
        ttl = int(time.time()) + (48 * 3600)  # 48 hours
        try:
            response = self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'#DAILY_SCRAPE_COUNT#{date}'},
                UpdateExpression='ADD #cnt :inc SET #ttl = if_not_exists(#ttl, :ttl)',
                ExpressionAttributeNames={'#cnt': 'count', '#ttl': 'ttl'},
                ExpressionAttributeValues={':inc': 1, ':ttl': ttl},
                ReturnValues='ALL_NEW',
            )
            new_count = int(response.get('Attributes', {}).get('count', 1))
            return {'count': new_count}
        except ClientError as e:
            logger.error('Error incrementing daily scrape count: %s', e)
            raise

    CHECKPOINT_ALLOWED_KEYS = frozenset(
        {'batchIndex', 'lastProfileId', 'connectionType', 'processedCount', 'totalCount', 'updatedAt'}
    )

    def save_import_checkpoint(self, user_id: str, checkpoint: dict[str, Any]) -> dict[str, Any]:
        """Save or update an import checkpoint. TTL auto-expires after 14 days."""
        safe_checkpoint = {k: v for k, v in checkpoint.items() if k in self.CHECKPOINT_ALLOWED_KEYS}
        ttl = int(time.time()) + (14 * 24 * 3600)  # 14 days
        item = {
            'PK': f'USER#{user_id}',
            'SK': '#IMPORT_CHECKPOINT',
            'ttl': ttl,
            **safe_checkpoint,
        }
        self.table.put_item(Item=item)
        return {'success': True}

    def get_import_checkpoint(self, user_id: str) -> dict[str, Any]:
        """Get the import checkpoint for a user."""
        try:
            response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': '#IMPORT_CHECKPOINT'})
            item = response.get('Item')
            if not item:
                return {}
            # Strip PK/SK from response
            checkpoint = {k: v for k, v in item.items() if k not in ('PK', 'SK', 'ttl')}
            return {'checkpoint': checkpoint}
        except ClientError as e:
            logger.error('Error getting import checkpoint: %s', e)
            return {}

    def clear_import_checkpoint(self, user_id: str) -> dict[str, Any]:
        """Delete the import checkpoint for a user."""
        try:
            self.table.delete_item(Key={'PK': f'USER#{user_id}', 'SK': '#IMPORT_CHECKPOINT'})
            return {'success': True}
        except ClientError as e:
            logger.error('Error clearing import checkpoint: %s', e)
            raise

    # Hostnames that should be rejected for SSRF prevention
    _RESERVED_HOSTNAME_SUFFIXES = ('.local', '.internal', '.localhost')
    _RESERVED_HOSTNAMES = {'localhost'}

    def _is_safe_url(self, url: str) -> bool:
        """Validate URL is safe (HTTPS, non-private IP, valid hostname).

        Uses parse-only validation without DNS resolution (ADR-001).
        """
        try:
            parsed = urlparse(url)
            if parsed.scheme != 'https':
                return False
            hostname = parsed.hostname
            if not hostname:
                return False

            # Reject reserved hostnames
            if hostname in self._RESERVED_HOSTNAMES:
                return False
            if any(hostname.endswith(suffix) for suffix in self._RESERVED_HOSTNAME_SUFFIXES):
                return False

            # If hostname is an IP literal, check for private/reserved ranges
            try:
                ip = ipaddress.ip_address(hostname)
                if ip.is_private or ip.is_reserved or ip.is_loopback or ip.is_link_local:
                    return False
            except ValueError:
                pass  # Not an IP literal, hostname is fine

            return True
        except (ValueError, OSError) as e:
            logger.warning('URL safety check failed for URL: %s', e)
            return False
