"""EdgeMessageService - Message CRUD for user-profile edges."""

import logging
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from shared_services.base_service import BaseService
from shared_services.edge_constants import MAX_MESSAGES_PER_EDGE, encode_profile_id

logger = logging.getLogger(__name__)


class EdgeMessageService(BaseService):
    """Manages message operations on edges."""

    def __init__(self, table):
        super().__init__()
        self.table = table

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
