"""Tests for CircuitBreaker pattern implementation."""
import time
from unittest.mock import patch

import pytest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..', 'backend/lambdas/shared/python'))

from shared_services.circuit_breaker import CircuitBreaker, CircuitBreakerOpenError


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
