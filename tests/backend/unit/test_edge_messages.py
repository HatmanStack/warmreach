"""Unit tests for EdgeMessageService."""
import base64
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared_services.edge_message_service import EdgeMessageService
from errors.exceptions import ExternalServiceError, ValidationError


def _encode(profile_id: str) -> str:
    return base64.urlsafe_b64encode(profile_id.encode()).decode()


class TestAddMessage:
    """Tests for EdgeMessageService.add_message."""

    def test_appends_message_to_existing_edge(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'messages': []}}
        service = EdgeMessageService(table=mock_table)

        result = service.add_message('test-user', 'https://linkedin.com/in/test', 'Hello!', 'outbound')

        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    def test_respects_max_messages_limit(self):
        mock_table = MagicMock()
        # Simulate 100 existing messages (at limit)
        mock_table.get_item.return_value = {
            'Item': {'messages': [{'content': f'msg-{i}'} for i in range(100)]}
        }
        service = EdgeMessageService(table=mock_table)

        result = service.add_message('test-user', 'profile-1', 'new msg', 'outbound')

        assert result['success'] is True
        # Should have called update_item with trimmed messages
        call_kwargs = mock_table.update_item.call_args[1]
        msgs = call_kwargs['ExpressionAttributeValues'][':msgs']
        assert len(msgs) == 100  # 99 old + 1 new

    def test_empty_message_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeMessageService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_message('test-user', 'profile-1', '', 'outbound')

    def test_whitespace_only_message_raises_validation_error(self):
        mock_table = MagicMock()
        service = EdgeMessageService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_message('test-user', 'profile-1', '   ', 'outbound')

    def test_dynamo_error_raises_external_service_error(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'GetItem',
        )
        service = EdgeMessageService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.add_message('test-user', 'profile-1', 'Hello', 'outbound')


class TestGetMessages:
    """Tests for EdgeMessageService.get_messages."""

    def test_returns_messages_in_order(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'messages': [
                    {'content': 'first', 'timestamp': '2024-01-01', 'type': 'outbound'},
                    {'content': 'second', 'timestamp': '2024-01-02', 'type': 'inbound'},
                ],
                'addedAt': '2024-01-01',
            }
        }
        service = EdgeMessageService(table=mock_table)

        result = service.get_messages('test-user', 'profile-1')

        assert result['success'] is True
        assert result['count'] == 2
        assert result['messages'][0]['content'] == 'first'
        assert result['messages'][1]['content'] == 'second'

    def test_returns_empty_when_no_edge(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = EdgeMessageService(table=mock_table)

        result = service.get_messages('test-user', 'profile-1')

        assert result['success'] is True
        assert result['messages'] == []
        assert result['count'] == 0


class TestUpdateMessages:
    """Tests for EdgeMessageService.update_messages."""

    def test_replaces_full_messages_list(self):
        mock_table = MagicMock()
        service = EdgeMessageService(table=mock_table)

        new_messages = [{'content': 'msg1'}, {'content': 'msg2'}]
        result = service.update_messages('test-user', 'profile-1', new_messages)

        assert result['success'] is True
        assert result['messageCount'] == 2
        mock_table.update_item.assert_called_once()

    def test_trims_to_max_messages(self):
        mock_table = MagicMock()
        service = EdgeMessageService(table=mock_table)

        big_list = [{'content': f'msg-{i}'} for i in range(150)]
        result = service.update_messages('test-user', 'profile-1', big_list)

        assert result['messageCount'] == 100

    def test_handles_empty_messages_list(self):
        mock_table = MagicMock()
        service = EdgeMessageService(table=mock_table)

        result = service.update_messages('test-user', 'profile-1', [])

        assert result['success'] is True
        assert result['messageCount'] == 0
