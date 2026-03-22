"""Unit tests for ActivityService - activity timeline queries."""

import base64
import json
from unittest.mock import MagicMock

import pytest

from shared_services.activity_service import ActivityService


class TestGetActivityTimeline:
    """Tests for get_activity_timeline."""

    def test_basic_query_params(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123')

        call_kwargs = mock_table.query.call_args[1]
        assert ':pk' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':pk'] == 'USER#user-123'
        assert call_kwargs['ScanIndexForward'] is False

    def test_sk_prefix_filter(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123')

        call_kwargs = mock_table.query.call_args[1]
        assert 'ACTIVITY#' in str(call_kwargs['KeyConditionExpression']) or 'ACTIVITY#' in str(call_kwargs['ExpressionAttributeValues'])

    def test_event_type_filter(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123', event_type='message_sent')

        call_kwargs = mock_table.query.call_args[1]
        assert 'FilterExpression' in call_kwargs
        assert call_kwargs['ExpressionAttributeValues'][':event_type'] == 'message_sent'

    def test_event_types_array_filter(self):
        """event_types param should produce an IN filter expression."""
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline(
            'user-123',
            event_types=['ai_message_generated', 'ai_tone_analysis', 'ai_deep_research'],
        )

        call_kwargs = mock_table.query.call_args[1]
        assert 'FilterExpression' in call_kwargs
        assert 'IN' in call_kwargs['FilterExpression']
        vals = call_kwargs['ExpressionAttributeValues']
        assert vals[':et0'] == 'ai_message_generated'
        assert vals[':et1'] == 'ai_tone_analysis'
        assert vals[':et2'] == 'ai_deep_research'

    def test_event_type_takes_precedence_over_event_types(self):
        """Single event_type should be used if both are provided."""
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline(
            'user-123',
            event_type='message_sent',
            event_types=['ai_message_generated', 'ai_tone_analysis'],
        )

        call_kwargs = mock_table.query.call_args[1]
        # Single event_type should win
        assert ':event_type' in call_kwargs['ExpressionAttributeValues']
        assert ':et0' not in call_kwargs['ExpressionAttributeValues']

    def test_date_range_both(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123', start_date='2024-01-01', end_date='2024-01-31')

        call_kwargs = mock_table.query.call_args[1]
        vals = call_kwargs['ExpressionAttributeValues']
        assert ':sk_start' in vals
        assert ':sk_end' in vals
        assert vals[':sk_start'] == 'ACTIVITY#2024-01-01'
        assert vals[':sk_end'].startswith('ACTIVITY#2024-01-31')

    def test_start_date_only(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123', start_date='2024-01-01')

        call_kwargs = mock_table.query.call_args[1]
        vals = call_kwargs['ExpressionAttributeValues']
        assert ':sk_start' in vals
        assert vals[':sk_start'] == 'ACTIVITY#2024-01-01'

    def test_end_date_only(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123', end_date='2024-01-31')

        call_kwargs = mock_table.query.call_args[1]
        vals = call_kwargs['ExpressionAttributeValues']
        assert ':sk_end' in vals

    def test_pagination_cursor_decode(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        cursor_data = {'PK': 'USER#user-123', 'SK': 'ACTIVITY#2024-01-01#message_sent'}
        cursor = base64.urlsafe_b64encode(json.dumps(cursor_data).encode()).decode()

        service.get_activity_timeline('user-123', cursor=cursor)

        call_kwargs = mock_table.query.call_args[1]
        assert call_kwargs['ExclusiveStartKey'] == cursor_data

    def test_next_cursor_returned(self):
        mock_table = MagicMock()
        last_key = {'PK': 'USER#user-123', 'SK': 'ACTIVITY#2024-01-01#message_sent'}
        mock_table.query.return_value = {
            'Items': [
                {'eventType': 'message_sent', 'timestamp': '2024-01-01T00:00:00+00:00', 'metadata': {}}
            ],
            'Count': 1,
            'LastEvaluatedKey': last_key,
        }
        service = ActivityService(table=mock_table)

        result = service.get_activity_timeline('user-123')

        assert result['nextCursor'] is not None
        decoded = json.loads(base64.urlsafe_b64decode(result['nextCursor']))
        assert decoded == last_key

    def test_no_cursor_when_no_more_pages(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {'eventType': 'message_sent', 'timestamp': '2024-01-01T00:00:00+00:00'}
            ],
            'Count': 1,
        }
        service = ActivityService(table=mock_table)

        result = service.get_activity_timeline('user-123')

        assert result['nextCursor'] is None

    def test_limit_clamped_max(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123', limit=200)

        call_kwargs = mock_table.query.call_args[1]
        assert call_kwargs['Limit'] == 100

    def test_limit_clamped_min(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123', limit=0)

        call_kwargs = mock_table.query.call_args[1]
        assert call_kwargs['Limit'] == 1

    def test_empty_results(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        result = service.get_activity_timeline('user-123')

        assert result['success'] is True
        assert result['activities'] == []
        assert result['nextCursor'] is None
        assert result['count'] == 0

    def test_formatted_items(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'eventType': 'message_sent',
                    'timestamp': '2024-01-01T00:00:00+00:00',
                    'metadata': {'profileId': 'abc'},
                },
                {
                    'eventType': 'connection_status_change',
                    'timestamp': '2024-01-02T00:00:00+00:00',
                },
            ],
            'Count': 2,
        }
        service = ActivityService(table=mock_table)

        result = service.get_activity_timeline('user-123')

        assert len(result['activities']) == 2
        assert result['activities'][0]['eventType'] == 'message_sent'
        assert result['activities'][0]['metadata'] == {'profileId': 'abc'}
        assert result['activities'][1]['metadata'] == {}
        assert result['count'] == 2

    def test_default_limit(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [], 'Count': 0}
        service = ActivityService(table=mock_table)

        service.get_activity_timeline('user-123')

        call_kwargs = mock_table.query.call_args[1]
        assert call_kwargs['Limit'] == 50
