"""Tests for CircuitBreaker pattern implementation."""
import logging
import time
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

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

    def test_dynamodb_store_reraises_on_read_error_by_default(self, caplog):
        """DynamoDBStore.get_state re-raises ClientError by default (no silent fail-open)."""
        mock_table = MagicMock()
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}},
            'GetItem',
        )
        store = DynamoDBStore(mock_table)
        with caplog.at_level(logging.ERROR):
            with pytest.raises(ClientError):
                store.get_state('svc')
        assert any(
            r.exc_info is not None and 'circuit breaker' in r.getMessage().lower()
            for r in caplog.records
        )

    def test_dynamodb_store_fail_open_returns_empty(self, caplog):
        """DynamoDBStore with fail_open=True returns empty dict on read error."""
        mock_table = MagicMock()
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'x'}},
            'GetItem',
        )
        store = DynamoDBStore(mock_table, fail_open=True)
        with caplog.at_level(logging.ERROR):
            result = store.get_state('svc')
        assert result == {}
        assert any(r.exc_info is not None for r in caplog.records)

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


class TestFailureCounterIsAtomic:
    """HIGH #10 plus the defect underneath it.

    ``on_failure`` used to read ``failure_count``, add one in Python, and write
    the whole item back with ``put_item``. Two things were wrong with that:

    1. ``last_failure_time`` is a ``time.time()`` float, and the boto3 resource
       API rejects floats outright. ``set_state``'s best-effort ``except
       Exception`` swallowed the TypeError, so a DynamoDB-backed breaker
       persisted **nothing** on the failure path and could never open at all —
       strictly worse than the lost update the audit described.
    2. Even with the write working, concurrent invocations sharing
       ``CB#<service>/STATE`` all read the same count and all wrote the same
       incremented value, so under exactly the concurrency where a breaker
       matters the count never reached ``failure_threshold``.
    """

    @staticmethod
    def _table():
        import boto3

        ddb = boto3.resource('dynamodb', region_name='us-east-1')
        return ddb.create_table(
            TableName='cb-test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )

    @staticmethod
    def _boom():
        raise RuntimeError('downstream is down')

    @mock_aws
    def test_a_single_failure_actually_persists(self):
        """Regression for the swallowed float TypeError: before the fix this
        item did not exist at all after a failure."""
        table = self._table()
        cb = CircuitBreaker(service_name='svc', failure_threshold=5, store=DynamoDBStore(table))

        with pytest.raises(RuntimeError):
            cb.call(self._boom)

        item = table.get_item(Key={'PK': 'CB#svc', 'SK': 'STATE'}).get('Item')
        assert item is not None, 'failure state was not persisted at all'
        assert int(item['failure_count']) == 1
        assert item['last_failure_time'] is not None
        assert not cb.persist_failed

    @mock_aws
    def test_breaker_opens_at_threshold_with_a_dynamodb_store(self):
        table = self._table()
        cb = CircuitBreaker(service_name='svc', failure_threshold=3, store=DynamoDBStore(table))

        for _ in range(3):
            with pytest.raises(RuntimeError):
                cb.call(self._boom)

        item = table.get_item(Key={'PK': 'CB#svc', 'SK': 'STATE'})['Item']
        assert item['state'] == 'open'
        assert int(item['failure_count']) == 3
        # And it now rejects rather than calling through.
        with pytest.raises(CircuitBreakerOpenError):
            cb.call(lambda: 'should not run')

    @mock_aws
    def test_a_stale_read_cannot_lose_an_increment(self):
        """The lost update, reproduced deterministically.

        Threads are deliberately not used here: moto's DynamoDB backend is not
        thread-safe, so a ThreadPoolExecutor test drops increments inside moto
        itself (measured: 7 failures in 20 runs, ``assert 8 == 10``) and would
        be asserting the fake rather than the code. What actually defines the
        defect is a **stale read followed by a write**, and CachedDynamoDBStore
        produces that exactly: two breakers both holding a cached count of 0,
        as two concurrent Lambda invocations would.

        Old behaviour: each computed 0 + 1 in Python and put_item'd the whole
        item, so the stored count finished at 1. New behaviour: each issues a
        server-side ADD, so the counts are 1 and 2.
        """
        table = self._table()
        stores = [CachedDynamoDBStore(table, cache_ttl_seconds=300) for _ in range(2)]
        breakers = [CircuitBreaker(service_name='svc', failure_threshold=5, store=s) for s in stores]

        # Both read first, so both hold the same stale view — the race, made explicit.
        for cb in breakers:
            assert cb.state == 'closed'
        for cb in breakers:
            cb.on_failure(RuntimeError('boom'))

        item = table.get_item(Key={'PK': 'CB#svc', 'SK': 'STATE'})['Item']
        assert int(item['failure_count']) == 2, 'an increment was lost to a stale read'

    @mock_aws
    def test_ten_failures_across_ten_breaker_instances_count_to_ten(self):
        """Ten separate breaker objects, as ten Lambda invocations would be, all
        sharing one stored item."""
        table = self._table()
        breakers = [
            CircuitBreaker(service_name='svc', failure_threshold=50, store=DynamoDBStore(table)) for _ in range(10)
        ]
        for cb in breakers:
            cb.on_failure(RuntimeError('boom'))

        item = table.get_item(Key={'PK': 'CB#svc', 'SK': 'STATE'})['Item']
        assert int(item['failure_count']) == 10

    @mock_aws
    def test_two_breakers_crossing_the_threshold_together_open_once(self, caplog):
        """A breaker at threshold-1 plus two failures produces one transition,
        not one per invocation — the second try_open hits
        ConditionalCheckFailedException and stays quiet."""
        table = self._table()
        table.put_item(Item={'PK': 'CB#svc', 'SK': 'STATE', 'state': 'closed', 'failure_count': 4})
        # Cached stores again, so both breakers believe the state is still 'closed'
        # when they cross — which is what makes the double-transition possible.
        stores = [CachedDynamoDBStore(table, cache_ttl_seconds=300) for _ in range(2)]
        breakers = [CircuitBreaker(service_name='svc', failure_threshold=5, store=s) for s in stores]
        for cb in breakers:
            assert cb.state == 'closed'

        with caplog.at_level(logging.WARNING):
            for cb in breakers:
                cb.on_failure(RuntimeError('boom'))

        item = table.get_item(Key={'PK': 'CB#svc', 'SK': 'STATE'})['Item']
        assert item['state'] == 'open'
        assert int(item['failure_count']) == 6
        transitions = [r for r in caplog.records if 'closed -> open' in r.getMessage()]
        assert len(transitions) == 1, f'expected exactly one transition log, got {len(transitions)}'

    def test_on_failure_never_puts_the_whole_item_back(self):
        """The counter must not travel through put_item — that is the shape that
        loses concurrent increments."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'state': 'closed', 'failure_count': 1}}
        mock_table.update_item.return_value = {'Attributes': {'state': 'closed', 'failure_count': 2}}
        cb = CircuitBreaker(service_name='svc', failure_threshold=5, store=DynamoDBStore(mock_table))

        cb.on_failure(RuntimeError('boom'))

        mock_table.put_item.assert_not_called()
        update_kwargs = mock_table.update_item.call_args.kwargs
        assert 'ADD failure_count :one' in update_kwargs['UpdateExpression']
        assert update_kwargs['ReturnValues'] == 'ALL_NEW'

    def test_opening_uses_a_conditional_write(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'state': 'closed', 'failure_count': 4}}
        mock_table.update_item.return_value = {'Attributes': {'state': 'closed', 'failure_count': 5}}
        cb = CircuitBreaker(service_name='svc', failure_threshold=5, store=DynamoDBStore(mock_table))

        cb.on_failure(RuntimeError('boom'))

        conditional = [c for c in mock_table.update_item.call_args_list if 'ConditionExpression' in c.kwargs]
        assert conditional, 'the -> open flip must be a conditional write'
        assert '#state <> :open' in conditional[-1].kwargs['ConditionExpression']


class TestPersistFailureIsVisible:
    """LOW #26: writes stay best-effort — a breaker that cannot persist must not
    break the caller's code — but the failure is now countable."""

    def test_client_error_on_increment_sets_persist_failed_and_logs_the_marker(self, caplog):
        from shared_services.circuit_breaker import PERSIST_FAILURE_MARKER

        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'state': 'closed', 'failure_count': 0}}
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}},
            'UpdateItem',
        )
        store = DynamoDBStore(mock_table)
        cb = CircuitBreaker(service_name='svc', failure_threshold=5, store=store)

        with caplog.at_level(logging.ERROR):
            cb.on_failure(RuntimeError('boom'))  # must not raise

        assert cb.persist_failed is True
        assert store.persist_failed is True
        # The marker is in the MESSAGE, because observability.py filters `extra`
        # through an allowlist and would drop a field the alarm keyed on.
        assert any(PERSIST_FAILURE_MARKER in r.getMessage() for r in caplog.records)

    def test_client_error_on_set_state_sets_persist_failed(self, caplog):
        from shared_services.circuit_breaker import PERSIST_FAILURE_MARKER

        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {}}
        mock_table.put_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}},
            'PutItem',
        )
        store = DynamoDBStore(mock_table)

        with caplog.at_level(logging.ERROR):
            store.set_state('svc', {'state': 'closed', 'failure_count': 0})  # must not raise

        assert store.persist_failed is True
        assert any(PERSIST_FAILURE_MARKER in r.getMessage() for r in caplog.records)

    def test_a_healthy_breaker_reports_no_persist_failure(self):
        cb = CircuitBreaker(service_name='svc')
        cb.on_failure(RuntimeError('boom'))
        assert cb.persist_failed is False

    def test_floats_are_coerced_rather_than_rejected(self):
        """The root cause of the silent total write failure."""
        from decimal import Decimal

        from shared_services.circuit_breaker import _to_dynamo_number

        assert _to_dynamo_number(1769499999.123) == Decimal('1769499999.123')
        assert _to_dynamo_number(5) == 5
        assert _to_dynamo_number(None) is None
        assert _to_dynamo_number('open') == 'open'


class TestOpensEvenWhenTheStoreCannotPersist:
    """A breaker that cannot write its state must still protect this process.

    The open transition became conditional on `store.try_open()` succeeding.
    try_open returns False both when someone else already opened the circuit and
    when the write failed — and CachedDynamoDBStore drops its cached copy either
    way, so a persist failure left the breaker reporting `closed` forever. Every
    caller then kept paying the full downstream timeout instead of fast-failing,
    with nothing logged.
    """

    class _UnwritableStore:
        """Accepts increments, refuses every state write — an IAM/throttle
        failure on the CB# item."""

        def __init__(self):
            self._state = {}
            self.persist_failed = False

        def get_state(self, service_name):
            return dict(self._state)

        def set_state(self, service_name, state_data):
            # Mirrors DynamoDBStore: the write is swallowed and flagged, while
            # the in-process copy still moves — that is what makes local
            # protection possible at all.
            self.persist_failed = True
            self._state = dict(state_data)

        def increment_failure(self, service_name, *, now):
            self._state['failure_count'] = int(self._state.get('failure_count', 0)) + 1
            self._state['last_failure_time'] = now
            return dict(self._state)

        def try_open(self, service_name, *, now):
            self.persist_failed = True
            return False

    def test_the_breaker_opens_locally_when_try_open_cannot_persist(self):
        from shared_services.circuit_breaker import CircuitBreaker

        store = self._UnwritableStore()
        breaker = CircuitBreaker('ragstack', failure_threshold=3, store=store)

        for _ in range(3):
            breaker.on_failure(Exception('downstream is down'))

        assert breaker.state == 'open'

    def test_a_lost_race_still_reports_no_transition(self):
        """try_open returning False because someone else opened it is NOT a
        persist failure and must not be treated as one."""
        from shared_services.circuit_breaker import CircuitBreaker

        store = self._UnwritableStore()

        def already_open(service_name, *, now):
            return False  # lost the race; persist_failed stays False

        store.try_open = already_open
        breaker = CircuitBreaker('ragstack', failure_threshold=3, store=store)

        assert breaker._open_or_fall_back_locally(now=0.0) is False
