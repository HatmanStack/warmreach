"""Unit tests for activity_writer - fire-and-forget DynamoDB activity writer."""

import logging
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared_services.activity_writer import ActivityEventType, write_activity


class TestActivityEventType:
    """Tests for activity event type constants."""

    def test_all_event_types_defined(self):
        expected = {
            'connection_status_change',
            'message_sent',
            'command_dispatched',
            'ai_message_generated',
            'ai_tone_analysis',
            'ai_deep_research',
            'profile_metadata_updated',
            'user_settings_updated',
            'note_added',
            'profile_ingested',
        }
        actual = {e.value for e in ActivityEventType}
        assert actual == expected


class TestWriteActivity:
    """Tests for write_activity function."""

    def test_successful_write(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'connection_status_change')
        mock_table.put_item.assert_called_once()

    def test_pk_format(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'connection_status_change')
        item = mock_table.put_item.call_args[1]['Item']
        assert item['PK'] == 'USER#user-123'

    def test_sk_format(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'message_sent')
        item = mock_table.put_item.call_args[1]['Item']
        assert item['SK'].startswith('ACTIVITY#')
        # SK format: ACTIVITY#{timestamp}#{event_type}#{uuid}
        assert '#message_sent#' in item['SK']

    def test_sk_contains_uuid_suffix(self):
        """SK should include a UUID suffix for collision protection."""
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'message_sent')
        item = mock_table.put_item.call_args[1]['Item']
        parts = item['SK'].split('#')
        # parts: ['ACTIVITY', timestamp, event_type, uuid]
        assert len(parts) == 4
        # UUID part should be 36 chars (8-4-4-4-12 format)
        assert len(parts[3]) == 36

    def test_sk_unique_across_calls(self):
        """Two rapid calls should produce different SKs."""
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'message_sent')
        write_activity(mock_table, 'user-123', 'message_sent')
        items = [call[1]['Item'] for call in mock_table.put_item.call_args_list]
        assert items[0]['SK'] != items[1]['SK']

    def test_sk_contains_iso_timestamp(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'message_sent')
        item = mock_table.put_item.call_args[1]['Item']
        # SK format: ACTIVITY#{timestamp}#{event_type}#{uuid}
        parts = item['SK'].split('#')
        timestamp_str = parts[1]
        parsed = datetime.fromisoformat(timestamp_str)
        assert parsed.tzinfo is not None  # UTC-aware

    def test_event_type_in_item(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'ai_message_generated')
        item = mock_table.put_item.call_args[1]['Item']
        assert item['eventType'] == 'ai_message_generated'

    def test_timestamp_in_item(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'message_sent')
        item = mock_table.put_item.call_args[1]['Item']
        assert 'timestamp' in item
        # Should be parseable
        datetime.fromisoformat(item['timestamp'])

    def test_ttl_included(self):
        """Activity records should have a TTL attribute ~90 days in the future."""
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'message_sent')
        item = mock_table.put_item.call_args[1]['Item']
        assert 'ttl' in item
        now_ts = int(datetime.now(UTC).timestamp())
        # TTL should be ~90 days from now (allow 1 day tolerance)
        expected_min = now_ts + (89 * 86400)
        expected_max = now_ts + (91 * 86400)
        assert expected_min <= item['ttl'] <= expected_max

    def test_metadata_included_when_provided(self):
        mock_table = MagicMock()
        metadata = {'profileId': 'abc123', 'status': 'ally'}
        write_activity(mock_table, 'user-123', 'connection_status_change', metadata=metadata)
        item = mock_table.put_item.call_args[1]['Item']
        assert item['metadata'] == metadata

    def test_metadata_omitted_when_none(self):
        mock_table = MagicMock()
        write_activity(mock_table, 'user-123', 'connection_status_change', metadata=None)
        item = mock_table.put_item.call_args[1]['Item']
        assert 'metadata' not in item

    def test_fire_and_forget_on_client_error(self):
        """write_activity must not raise when DynamoDB fails."""
        mock_table = MagicMock()
        mock_table.put_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'PutItem',
        )
        # Should not raise
        write_activity(mock_table, 'user-123', 'message_sent')

    def test_fire_and_forget_logs_warning(self, caplog):
        """write_activity should log a warning when DynamoDB fails."""
        mock_table = MagicMock()
        mock_table.put_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'fail'}},
            'PutItem',
        )
        with caplog.at_level(logging.WARNING):
            write_activity(mock_table, 'user-123', 'message_sent')
        assert any('activity' in r.message.lower() or 'failed' in r.message.lower() for r in caplog.records)

    def test_fire_and_forget_on_generic_exception(self):
        """write_activity must not raise on any exception type."""
        mock_table = MagicMock()
        mock_table.put_item.side_effect = RuntimeError('unexpected')
        # Should not raise
        write_activity(mock_table, 'user-123', 'message_sent')
