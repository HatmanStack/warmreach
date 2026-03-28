"""Tests for CircuitBreaker pattern implementation."""
import time
from unittest.mock import MagicMock, patch

import pytest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..', 'backend/lambdas/shared/python'))

from shared_services.circuit_breaker import (
    CachedDynamoDBStore,
    CircuitBreaker,
    CircuitBreakerOpenError,
    DynamoDBStore,
)


class TestCircuitBreakerInit:
    def test_defaults(self):
        cb = CircuitBreaker()
        assert cb.state == 'closed'
        assert cb.failure_threshold == 5
        assert cb.recovery_timeout == 60.0

    def test_custom_params(self):
        cb = CircuitBreaker(service_name='test', failure_threshold=3, recovery_timeout=30.0)
        assert cb.service_name == 'test'
        assert cb.failure_threshold == 3
        assert cb.recovery_timeout == 30.0


class TestCircuitBreakerClosed:
    def test_successful_call_stays_closed(self):
        cb = CircuitBreaker()
        result = cb.call(lambda: 42)
        assert result == 42
        assert cb.state == 'closed'

    def test_single_failure_stays_closed(self):
        cb = CircuitBreaker(failure_threshold=3)
        def failing(): raise ValueError("err")
        with pytest.raises(ValueError):
            cb.call(failing)
        assert cb.state == 'closed'

    def test_trips_after_threshold_failures(self):
        cb = CircuitBreaker(failure_threshold=3)
        def failing(): raise RuntimeError("fail")
        for _ in range(3):
            with pytest.raises(RuntimeError):
                cb.call(failing)
        assert cb.state == 'open'

    def test_success_resets_failure_count(self):
        cb = CircuitBreaker(failure_threshold=3)
        def failing(): raise RuntimeError("fail")
        # 2 failures
        for _ in range(2):
            with pytest.raises(RuntimeError):
                cb.call(failing)
        # 1 success resets
        cb.call(lambda: 'ok')
        # 2 more failures should not trip (count reset)
        for _ in range(2):
            with pytest.raises(RuntimeError):
                cb.call(failing)
        assert cb.state == 'closed'


class TestCircuitBreakerOpen:
    def test_rejects_calls_when_open(self):
        cb = CircuitBreaker(failure_threshold=1)
        def failing(): raise RuntimeError("fail")
        with pytest.raises(RuntimeError):
            cb.call(failing)
        assert cb.state == 'open'
        with pytest.raises(CircuitBreakerOpenError) as exc_info:
            cb.call(lambda: 'should not run')
        assert 'Circuit breaker open' in str(exc_info.value)

    def test_open_error_includes_service_name(self):
        cb = CircuitBreaker(service_name='myservice', failure_threshold=1)
        def failing(): raise RuntimeError("fail")
        with pytest.raises(RuntimeError):
            cb.call(failing)
        with pytest.raises(CircuitBreakerOpenError) as exc_info:
            cb.call(lambda: None)
        assert 'myservice' in str(exc_info.value)


class TestCircuitBreakerHalfOpen:
    def test_transitions_to_half_open_after_recovery_timeout(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        def failing(): raise RuntimeError("fail")
        with pytest.raises(RuntimeError):
            cb.call(failing)
        # Check through dict info since we want raw value if possible or just use state
        assert cb.to_dict()['state'] == 'open'
        time.sleep(0.15)
        # Accessing state property triggers transition
        assert cb.state == 'half_open'

    def test_success_in_half_open_closes_circuit(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        def failing(): raise RuntimeError("fail")
        with pytest.raises(RuntimeError):
            cb.call(failing)
        time.sleep(0.15)
        result = cb.call(lambda: 'recovered')
        assert result == 'recovered'
        assert cb.state == 'closed'

    def test_failure_in_half_open_reopens_circuit(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        def failing(): raise RuntimeError("fail")
        with pytest.raises(RuntimeError):
            cb.call(failing)
        time.sleep(0.15)
        with pytest.raises(RuntimeError):
            cb.call(failing)
        assert cb.state == 'open'


class TestCircuitBreakerReset:
    def test_manual_reset_closes_circuit(self):
        cb = CircuitBreaker(failure_threshold=1)
        def failing(): raise RuntimeError("fail")
        with pytest.raises(RuntimeError):
            cb.call(failing)
        assert cb.state == 'open'
        cb.reset()
        assert cb.state == 'closed'
        # Can make calls again
        result = cb.call(lambda: 'works')
        assert result == 'works'


class TestCircuitBreakerToDict:
    def test_returns_state_info(self):
        cb = CircuitBreaker(service_name='svc', failure_threshold=5, recovery_timeout=30.0)
        info = cb.to_dict()
        assert info['service_name'] == 'svc'
        assert info['state'] == 'closed'
        assert info['failure_count'] == 0
        assert info['failure_threshold'] == 5
        assert info['recovery_timeout'] == 30.0


class TestCachedDynamoDBStore:
    """Tests for in-memory caching around DynamoDBStore."""

    def test_caches_get_state_within_ttl(self):
        """Consecutive reads within TTL window only hit DynamoDB once."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'state': 'closed', 'failure_count': 0}
        }
        store = CachedDynamoDBStore(mock_table, cache_ttl_seconds=5.0)

        # First read hits DynamoDB
        result1 = store.get_state('test-svc')
        assert result1['state'] == 'closed'
        assert mock_table.get_item.call_count == 1

        # Second read within TTL uses cache
        result2 = store.get_state('test-svc')
        assert result2['state'] == 'closed'
        assert mock_table.get_item.call_count == 1  # Still 1

    def test_cache_expires_after_ttl(self):
        """After TTL expires, the next read hits DynamoDB again."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'state': 'closed', 'failure_count': 0}
        }
        store = CachedDynamoDBStore(mock_table, cache_ttl_seconds=0.1)

        store.get_state('test-svc')
        assert mock_table.get_item.call_count == 1

        time.sleep(0.15)

        store.get_state('test-svc')
        assert mock_table.get_item.call_count == 2

    def test_set_state_updates_cache_and_dynamodb(self):
        """Writes persist to DynamoDB and update the in-memory cache."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {}}
        store = CachedDynamoDBStore(mock_table, cache_ttl_seconds=5.0)

        state_data = {'state': 'open', 'failure_count': 5}
        store.set_state('test-svc', state_data)

        # DynamoDB write happened
        mock_table.put_item.assert_called_once()

        # Subsequent read uses cache, no DynamoDB read
        result = store.get_state('test-svc')
        assert result['state'] == 'open'
        assert result['failure_count'] == 5
        assert mock_table.get_item.call_count == 0  # Never read from DB

    def test_circuit_breaker_with_cached_store_reduces_reads(self):
        """CircuitBreaker using CachedDynamoDBStore reduces DynamoDB round trips."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {}}
        store = CachedDynamoDBStore(mock_table, cache_ttl_seconds=5.0)
        cb = CircuitBreaker(service_name='test', store=store)

        # A successful call involves multiple internal reads
        cb.call(lambda: 42)

        # With caching, DynamoDB should be read at most once
        assert mock_table.get_item.call_count <= 1
