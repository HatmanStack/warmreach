"""Circuit Breaker pattern for external service calls.

Prevents cascading failures by tracking error rates and temporarily
disabling calls to failing services. Transitions:
  closed (healthy) -> open (failing) -> half_open (testing) -> closed
"""

import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

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

    def __init__(self, table, ttl_seconds: int = 3600):
        self.table = table
        self.ttl_seconds = ttl_seconds

    def get_state(self, service_name: str) -> dict[str, Any]:
        try:
            resp = self.table.get_item(Key={'PK': f'CB#{service_name}', 'SK': 'STATE'})
            return resp.get('Item', {})
        except Exception as e:
            logger.warning(f'Failed to get circuit breaker state from DynamoDB for {service_name}: {e}')
            # Fallback to empty state which defaults to 'closed'
            return {}

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        try:
            item = {
                'PK': f'CB#{service_name}',
                'SK': 'STATE',
                'ttl': int(time.time()) + self.ttl_seconds,
                **state_data,
            }
            self.table.put_item(Item=item)
        except Exception as e:
            logger.error(f'Failed to set circuit breaker state in DynamoDB: {e}')


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
        """Current circuit state, checking if open circuit should transition to half-open."""
        data = self._get_local_state()
        state = data['state']
        last_failure_time = data['last_failure_time']

        if state == 'open' and self._should_attempt_recovery(last_failure_time):
            state = 'half_open'
            self._update_local_state(state=state, half_open_calls=0)
            logger.info(f"Circuit breaker '{self.service_name}': open -> half_open")
        return state

    def call(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        """Execute function through the circuit breaker."""
        current_state = self.state  # Trigger transition check and potential write
        data = self._get_local_state()  # Read post-transition state

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
            logger.info(f"Circuit breaker '{self.service_name}': half_open -> closed (recovery successful)")
        self._update_local_state(state='closed', failure_count=0, last_failure_time=None, half_open_calls=0)

    def on_failure(self, error: Exception) -> None:
        """Track failure and potentially trip the breaker."""
        data = self._get_local_state()
        new_count = data['failure_count'] + 1
        now = time.time()

        if data['state'] == 'half_open':
            logger.warning(f"Circuit breaker '{self.service_name}': half_open -> open (recovery failed: {error})")
            self._update_local_state(state='open', failure_count=new_count, last_failure_time=now)
        elif new_count >= self.failure_threshold:
            logger.warning(
                f"Circuit breaker '{self.service_name}': closed -> open "
                f'(threshold {self.failure_threshold} reached: {error})'
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
