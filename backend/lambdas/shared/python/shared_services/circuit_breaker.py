"""Circuit Breaker pattern for external service calls.

Prevents cascading failures by tracking error rates and temporarily
disabling calls to failing services. Transitions:
  closed (healthy) -> open (failing) -> half_open (testing) -> closed
"""

import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


class CircuitBreakerStore(Protocol):
    """Protocol for circuit breaker state storage."""

    def get_state(self, service_name: str) -> dict[str, Any]: ...
    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None: ...


class InMemoryStore:
    """Default in-memory storage for circuit breaker state."""

    def __init__(self):
        self._storage: dict[str, dict[str, Any]] = {}

    def get_state(self, service_name: str) -> dict[str, Any]:
        return self._storage.get(service_name, {})

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        self._storage[service_name] = state_data


class DynamoDBStore:
    """DynamoDB-backed storage for distributed circuit breaker state."""

    def __init__(self, table, ttl_seconds: int = 86400, fail_open: bool = False):
        """Initialize DynamoDB-backed circuit breaker store.

        Args:
            table: DynamoDB table resource.
            ttl_seconds: TTL for state records. Default 24h. A shorter TTL risks
                silent reset to closed while a downstream service is still failing.
            fail_open: If True, treat DynamoDB read failures as 'no record'
                (circuit assumed healthy). Default False (re-raise), so caller
                can degrade explicitly rather than silently assuming health.
        """
        self.table = table
        self.ttl_seconds = ttl_seconds
        self.fail_open = fail_open

    def get_state(self, service_name: str) -> dict[str, Any]:
        try:
            resp = self.table.get_item(Key={'PK': f'CB#{service_name}', 'SK': 'STATE'})
            return resp.get('Item', {})
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', 'Unknown')
            logger.exception(
                'Failed to get circuit breaker state from DynamoDB',
                extra={
                    'subsystem': 'circuit_breaker',
                    'service_name': service_name,
                    'error_code': code,
                },
            )
            if self.fail_open:
                # Caller opted in: assume healthy on DDB outage.
                return {}
            raise

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        try:
            item = {
                'PK': f'CB#{service_name}',
                'SK': 'STATE',
                'ttl': int(time.time()) + self.ttl_seconds,
                **state_data,
            }
            self.table.put_item(Item=item)
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', 'Unknown')
            logger.exception(
                'Failed to set circuit breaker state in DynamoDB',
                extra={
                    'subsystem': 'circuit_breaker',
                    'service_name': service_name,
                    'error_code': code,
                },
            )
        except Exception:
            # set_state is best-effort: serialization errors, float/decimal
            # coercion, and other boto runtime issues must not break the
            # circuit breaker's in-memory protection around the caller's code.
            logger.exception(
                'Unexpected error setting circuit breaker state in DynamoDB',
                extra={'subsystem': 'circuit_breaker', 'service_name': service_name},
            )


class CachedDynamoDBStore:
    """DynamoDB store with short-lived in-memory cache to reduce round trips.

    Wraps DynamoDBStore with a per-service-name TTL cache. Within a single
    Lambda invocation the circuit state rarely changes between consecutive
    reads, so caching for a few seconds eliminates redundant DynamoDB calls
    (typically from 2-3 per circuit breaker call down to 0-1).
    """

    def __init__(
        self,
        table,
        ttl_seconds: int = 3600,
        cache_ttl_seconds: float = 5.0,
        fail_open: bool = False,
    ):
        self._inner = DynamoDBStore(table, ttl_seconds, fail_open=fail_open)
        self._cache_ttl = cache_ttl_seconds
        self._cache: dict[str, dict[str, Any]] = {}
        self._cache_ts: dict[str, float] = {}

    def _is_fresh(self, service_name: str) -> bool:
        ts = self._cache_ts.get(service_name)
        if ts is None:
            return False
        return (time.time() - ts) < self._cache_ttl

    def get_state(self, service_name: str) -> dict[str, Any]:
        if self._is_fresh(service_name):
            return self._cache[service_name]
        state = self._inner.get_state(service_name)
        self._cache[service_name] = state
        self._cache_ts[service_name] = time.time()
        return state

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        self._inner.set_state(service_name, state_data)
        # Update cache immediately so subsequent reads see the new state
        self._cache[service_name] = state_data
        self._cache_ts[service_name] = time.time()


class CircuitBreakerOpenError(Exception):
    """Raised when circuit is open and calls are rejected."""

    def __init__(self, service_name: str, recovery_time_remaining: float):
        self.service_name = service_name
        self.recovery_time_remaining = recovery_time_remaining
        super().__init__(f"Circuit breaker open for '{service_name}'. Retry in {recovery_time_remaining:.1f}s")


class CircuitBreaker:
    """
    Circuit breaker with three states: closed, open, half_open.

    Args:
        service_name: Name for logging and error messages
        failure_threshold: Number of consecutive failures to trip the breaker
        recovery_timeout: Seconds to wait before attempting recovery
        half_open_max_calls: Max calls allowed in half-open state
        store: Optional storage backend (defaults to InMemoryStore)
    """

    def __init__(
        self,
        service_name: str = 'unknown',
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max_calls: int = 1,
        store: CircuitBreakerStore | None = None,
    ):
        self.service_name = service_name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max_calls = half_open_max_calls
        self.store = store or InMemoryStore()

    def _get_local_state(self) -> dict[str, Any]:
        state = self.store.get_state(self.service_name)
        return {
            'state': state.get('state', 'closed'),
            'failure_count': int(state.get('failure_count', 0)),
            'last_failure_time': state.get('last_failure_time'),
            'half_open_calls': int(state.get('half_open_calls', 0)),
        }

    def _update_local_state(self, **kwargs: Any) -> None:
        current = self._get_local_state()
        current.update(kwargs)
        self.store.set_state(self.service_name, current)

    @property
    def state(self) -> str:
        """Current circuit state, checking if open circuit should transition to half-open.

        The open -> half_open transition is implemented identically here and in
        ``call()``. Both paths do a read-then-write against the store without a
        lock, so they are race-safe only under a single-threaded executor (the
        Lambda Python worker model). If ``DynamoDBStore`` is ever used from
        concurrent threads or processes, wrap both transitions in a conditional
        update (e.g. ``attribute_exists AND #state = :open``) so only one
        caller performs the promotion.
        """
        data = self._get_local_state()
        state = data['state']
        last_failure_time = data['last_failure_time']

        if state == 'open' and self._should_attempt_recovery(last_failure_time):
            state = 'half_open'
            self._update_local_state(state=state, half_open_calls=0)
            logger.info("Circuit breaker '%s': open -> half_open", self.service_name)
        return state

    def call(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        """Execute function through the circuit breaker."""
        data = self._get_local_state()
        current_state = data['state']

        # Check open -> half_open transition inline (mirrors .state property logic)
        if current_state == 'open' and self._should_attempt_recovery(data['last_failure_time']):
            current_state = 'half_open'
            self._update_local_state(state=current_state, half_open_calls=0)
            data = self._get_local_state()
            logger.info("Circuit breaker '%s': open -> half_open", self.service_name)

        if current_state == 'open':
            remaining = self.recovery_timeout - (time.time() - (data['last_failure_time'] or 0))
            raise CircuitBreakerOpenError(self.service_name, max(0, remaining))

        if current_state == 'half_open' and data['half_open_calls'] >= self.half_open_max_calls:
            raise CircuitBreakerOpenError(self.service_name, self.recovery_timeout)

        try:
            if current_state == 'half_open':
                self._update_local_state(half_open_calls=data['half_open_calls'] + 1)

            result = func(*args, **kwargs)
            self.on_success()
            return result
        except Exception as e:
            self.on_failure(e)
            raise

    def on_success(self) -> None:
        """Reset failure tracking on successful call."""
        data = self._get_local_state()
        if data['state'] == 'half_open':
            logger.info("Circuit breaker '%s': half_open -> closed (recovery successful)", self.service_name)
        self._update_local_state(state='closed', failure_count=0, last_failure_time=None, half_open_calls=0)

    def on_failure(self, error: Exception) -> None:
        """Track failure and potentially trip the breaker."""
        data = self._get_local_state()
        new_count = data['failure_count'] + 1
        now = time.time()

        if data['state'] == 'half_open':
            logger.warning("Circuit breaker '%s': half_open -> open (recovery failed: %s)", self.service_name, error)
            self._update_local_state(state='open', failure_count=new_count, last_failure_time=now)
        elif new_count >= self.failure_threshold:
            logger.warning(
                "Circuit breaker '%s': closed -> open (threshold %s reached: %s)",
                self.service_name,
                self.failure_threshold,
                error,
            )
            self._update_local_state(state='open', failure_count=new_count, last_failure_time=now)
        else:
            self._update_local_state(failure_count=new_count, last_failure_time=now)

    def _should_attempt_recovery(self, last_failure_time: float | None) -> bool:
        """Check if enough time has passed to attempt recovery."""
        if last_failure_time is None:
            return True
        return (time.time() - last_failure_time) >= self.recovery_timeout

    def reset(self) -> None:
        """Manually reset the circuit breaker to closed state."""
        self._update_local_state(state='closed', failure_count=0, last_failure_time=None, half_open_calls=0)

    def to_dict(self) -> dict[str, Any]:
        """Return circuit breaker state as a dictionary for observability."""
        data = self._get_local_state()
        return {
            'service_name': self.service_name,
            'state': self.state,
            'failure_count': data['failure_count'],
            'failure_threshold': self.failure_threshold,
            'recovery_timeout': self.recovery_timeout,
        }
