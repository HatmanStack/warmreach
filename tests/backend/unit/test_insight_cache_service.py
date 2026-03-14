"""Unit tests for InsightCacheService - insight caching with deduplicated TTL pattern."""
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared_services.insight_cache_service import InsightCacheService


class TestGetCachedOrCompute:
    """Tests for the _get_cached_or_compute helper."""

    def _make_service(self, mock_table=None):
        return InsightCacheService(table=mock_table or MagicMock())

    def test_returns_cached_when_within_ttl(self):
        """Should return formatted cached data when within TTL."""
        mock_table = MagicMock()
        now = datetime.now(UTC).isoformat()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#u1',
                'SK': 'INSIGHTS#test',
                'data': 'cached-value',
                'computedAt': now,
            }
        }
        service = self._make_service(mock_table)
        compute_fn = MagicMock()
        format_fn = MagicMock(return_value={'formatted': True})

        result = service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, format_fn
        )

        assert result == {'formatted': True}
        compute_fn.assert_not_called()
        format_fn.assert_called_once()

    def test_calls_compute_when_cache_expired(self):
        """Should call compute_fn when cache is older than TTL."""
        mock_table = MagicMock()
        old_time = (datetime.now(UTC) - timedelta(days=10)).isoformat()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#u1',
                'SK': 'INSIGHTS#test',
                'computedAt': old_time,
            }
        }
        service = self._make_service(mock_table)
        compute_fn = MagicMock(return_value={'new': 'data'})

        result = service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, lambda x: x
        )

        compute_fn.assert_called_once()
        mock_table.put_item.assert_called_once()

    def test_calls_compute_when_force_recompute(self):
        """Should call compute_fn when force_recompute=True, ignoring cache."""
        mock_table = MagicMock()
        service = self._make_service(mock_table)
        compute_fn = MagicMock(return_value={'new': 'data'})

        result = service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, lambda x: x,
            force_recompute=True,
        )

        compute_fn.assert_called_once()
        # Should NOT call get_item when force_recompute
        mock_table.get_item.assert_not_called()

    def test_handles_missing_computed_at(self):
        """Should recompute when computedAt is missing."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'PK': 'USER#u1', 'SK': 'INSIGHTS#test'}
        }
        service = self._make_service(mock_table)
        compute_fn = MagicMock(return_value={'new': 'data'})

        result = service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, lambda x: x
        )

        compute_fn.assert_called_once()

    def test_handles_malformed_datetime(self):
        """Should recompute when computedAt is malformed."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#u1',
                'SK': 'INSIGHTS#test',
                'computedAt': 'not-a-datetime',
            }
        }
        service = self._make_service(mock_table)
        compute_fn = MagicMock(return_value={'new': 'data'})

        result = service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, lambda x: x
        )

        compute_fn.assert_called_once()

    def test_no_cached_item_triggers_compute(self):
        """Should compute when no cached item exists."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = self._make_service(mock_table)
        compute_fn = MagicMock(return_value={'result': 'fresh'})

        result = service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, lambda x: x
        )

        compute_fn.assert_called_once()

    def test_stores_result_with_ttl(self):
        """Should store computed result with computedAt and ttl."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = self._make_service(mock_table)
        compute_fn = MagicMock(return_value={'key': 'val'})

        service._get_cached_or_compute(
            'u1', 'INSIGHTS#test', compute_fn, lambda x: x
        )

        mock_table.put_item.assert_called_once()
        item = mock_table.put_item.call_args[1]['Item']
        assert item['PK'] == 'USER#u1'
        assert item['SK'] == 'INSIGHTS#test'
        assert 'computedAt' in item
        assert 'ttl' in item
        assert item['key'] == 'val'


class TestGetMessagingInsights:
    """Tests for get_messaging_insights end-to-end."""

    def test_returns_cached_insights(self):
        mock_table = MagicMock()
        now = datetime.now(UTC).isoformat()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#u1',
                'SK': 'INSIGHTS#messaging',
                'stats': {'totalOutbound': 5},
                'insights': ['insight1'],
                'sampleMessages': [],
                'computedAt': now,
            }
        }
        service = InsightCacheService(table=mock_table)

        result = service.get_messaging_insights('u1', edge_query_fn=MagicMock())

        assert result['stats']['totalOutbound'] == 5
        assert result['computedAt'] == now

    def test_computes_fresh_insights(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        edge_query_fn = MagicMock(return_value=[
            {'PK': 'USER#u1', 'SK': 'PROFILE#p1', 'messages': [
                {'content': 'hello', 'type': 'outbound', 'timestamp': '2024-01-01'}
            ]}
        ])
        service = InsightCacheService(table=mock_table)

        result = service.get_messaging_insights('u1', edge_query_fn=edge_query_fn)

        assert 'stats' in result
        assert 'computedAt' in result
        edge_query_fn.assert_called_once_with('u1')
        mock_table.put_item.assert_called_once()


class TestStoreMessageInsights:
    """Tests for store_message_insights."""

    def test_updates_existing_record(self):
        mock_table = MagicMock()
        service = InsightCacheService(table=mock_table)

        result = service.store_message_insights('u1', ['insight1', 'insight2'])

        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    def test_missing_record_raises_validation_error(self):
        mock_table = MagicMock()
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'fail'}},
            'UpdateItem',
        )
        service = InsightCacheService(table=mock_table)

        with pytest.raises(Exception, match='Messaging insights must be computed'):
            service.store_message_insights('u1', ['insight1'])


class TestComputeAndStoreScores:
    """Tests for compute_and_store_scores error handling."""

    def test_raises_external_service_error_on_client_error(self):
        """Should raise ExternalServiceError when DynamoDB raises ClientError."""
        mock_table = MagicMock()
        service = InsightCacheService(table=mock_table)

        def edge_query_fn(user_id):
            raise ClientError(
                {'Error': {'Code': 'InternalServerError', 'Message': 'DynamoDB failure'}},
                'Query',
            )

        with pytest.raises(Exception, match='Failed to compute scores'):
            service.compute_and_store_scores(
                'u1',
                edge_query_fn=edge_query_fn,
                scoring_service=MagicMock(),
                profile_metadata_fn=MagicMock(),
            )
