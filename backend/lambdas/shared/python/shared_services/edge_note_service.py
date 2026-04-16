"""EdgeNoteService - Note CRUD for user-profile edges."""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from shared_services.base_service import BaseService
from shared_services.edge_constants import MAX_NOTE_LENGTH, MAX_NOTES_PER_EDGE, encode_profile_id

logger = logging.getLogger(__name__)


class EdgeNoteService(BaseService):
    """Manages note operations on edges."""

    def __init__(self, table):
        super().__init__()
        self.table = table

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
            logger.error('DynamoDB error in add_note: %s', e)
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

            # Known limitation: read-modify-write without optimistic locking.
            # Concurrent updates to the same edge's notes can cause lost writes.
            # Low risk given single-user access patterns; add a version counter
            # or ConditionExpression if concurrent note editing becomes possible.
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
            logger.error('DynamoDB error in update_note: %s', e)
            raise ExternalServiceError(
                message='Failed to update note', service='DynamoDB', original_error=str(e)
            ) from e

    def delete_note(self, user_id: str, profile_id: str, note_id: str) -> dict[str, Any]:
        """Delete a note from an edge."""
        try:
            profile_id_b64 = encode_profile_id(profile_id)
            current_time = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'}

            # Known limitation: same read-modify-write race as update_note (see above).
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
            logger.error('DynamoDB error in delete_note: %s', e)
            raise ExternalServiceError(
                message='Failed to delete note', service='DynamoDB', original_error=str(e)
            ) from e
