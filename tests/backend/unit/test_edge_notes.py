"""Unit tests for EdgeNoteService."""
import base64
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared_services.edge_note_service import EdgeNoteService
from errors.exceptions import ExternalServiceError, ValidationError


class TestAddNote:
    """Tests for EdgeNoteService.add_note."""

    def test_creates_note_successfully(self):
        mock_table = MagicMock()
        service = EdgeNoteService(table=mock_table)

        result = service.add_note('test-user', 'profile-1', 'Great conversation today')

        assert result['success'] is True
        assert 'noteId' in result
        mock_table.update_item.assert_called_once()

    def test_respects_max_notes_limit(self):
        mock_table = MagicMock()
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'max notes'}},
            'UpdateItem',
        )
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ValidationError, match='Maximum'):
            service.add_note('test-user', 'profile-1', 'One more note')

    def test_validates_max_note_length(self):
        mock_table = MagicMock()
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ValidationError, match='exceeds'):
            service.add_note('test-user', 'profile-1', 'x' * 1001)

    def test_empty_content_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_note('test-user', 'profile-1', '')

    def test_whitespace_only_content_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_note('test-user', 'profile-1', '   ')


class TestUpdateNote:
    """Tests for EdgeNoteService.update_note."""

    def test_updates_note_content(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'old content', 'timestamp': '2024-01-01', 'updatedAt': '2024-01-01'},
                ]
            }
        }
        service = EdgeNoteService(table=mock_table)

        result = service.update_note('test-user', 'profile-1', 'note-1', 'new content')

        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    def test_raises_when_note_not_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'notes': []}}
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ValidationError, match='Note not found'):
            service.update_note('test-user', 'profile-1', 'nonexistent', 'content')


class TestDeleteNote:
    """Tests for EdgeNoteService.delete_note."""

    def test_deletes_note_successfully(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'notes': [
                    {'id': 'note-1', 'content': 'to delete'},
                    {'id': 'note-2', 'content': 'keep this'},
                ]
            }
        }
        service = EdgeNoteService(table=mock_table)

        result = service.delete_note('test-user', 'profile-1', 'note-1')

        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    def test_raises_when_note_not_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'notes': []}}
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ValidationError, match='Note not found'):
            service.delete_note('test-user', 'profile-1', 'nonexistent')

    def test_dynamo_error_raises_external_service_error(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'GetItem',
        )
        service = EdgeNoteService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.delete_note('test-user', 'profile-1', 'note-1')
