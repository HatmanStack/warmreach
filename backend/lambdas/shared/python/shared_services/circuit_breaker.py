"""Circuit Breaker pattern for external service calls.

Prevents cascading failures by tracking error rates and temporarily
disabling calls to failing services. Transitions:
  closed (healthy) -> open (failing) -> half_open (testing) -> closed
"""

import logging
import time
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)


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
    """

    def __init__(
        self,
        service_name: str = 'unknown',
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max_calls: int = 1,
    ):
        self.service_name = service_name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max_calls = half_open_max_calls

        self._state = 'closed'
        self._failure_count = 0
        self._last_failure_time: float | None = None
        self._half_open_calls = 0

    @property
    def state(self) -> str:
        """Current circuit state, checking if open circuit should transition to half-open."""
        if self._state == 'open' and self._should_attempt_recovery():
            self._state = 'half_open'
            self._half_open_calls = 0
            logger.info(f"Circuit breaker '{self.service_name}': open -> half_open")
        return self._state

    def call(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        """
        Execute function through the circuit breaker.

        Args:
            func: Callable to execute
            *args, **kwargs: Arguments passed to func

        Returns:
            Result of func

        Raises:
            CircuitBreakerOpenError: If circuit is open
            Exception: If func raises and circuit trips
        """
        current_state = self.state

        if current_state == 'open':
            remaining = self.recovery_timeout - (time.time() - (self._last_failure_time or 0))
            raise CircuitBreakerOpenError(self.service_name, max(0, remaining))

        if current_state == 'half_open' and self._half_open_calls >= self.half_open_max_calls:
            raise CircuitBreakerOpenError(self.service_name, self.recovery_timeout)

        try:
            if current_state == 'half_open':
                self._half_open_calls += 1

            result = func(*args, **kwargs)
            self.on_success()
            return result
        except Exception as e:
            self.on_failure(e)
            raise

    def on_success(self) -> None:
        """Reset failure tracking on successful call. Can be called directly for manual tracking."""
        if self._state == 'half_open':
            logger.info(f"Circuit breaker '{self.service_name}': half_open -> closed (recovery successful)")
        self._state = 'closed'
        self._failure_count = 0
        self._last_failure_time = None
        self._half_open_calls = 0

    def on_failure(self, error: Exception) -> None:
        """Track failure and potentially trip the breaker. Can be called directly for manual tracking."""
        self._failure_count += 1
        self._last_failure_time = time.time()

        if self._state == 'half_open':
            logger.warning(f"Circuit breaker '{self.service_name}': half_open -> open (recovery failed: {error})")
            self._state = 'open'
        elif self._failure_count >= self.failure_threshold:
            logger.warning(
                f"Circuit breaker '{self.service_name}': closed -> open "
                f'(threshold {self.failure_threshold} reached: {error})'
            )
            self._state = 'open'

    def _should_attempt_recovery(self) -> bool:
        """Check if enough time has passed to attempt recovery."""
        if self._last_failure_time is None:
            return True
        return (time.time() - self._last_failure_time) >= self.recovery_timeout

    def reset(self) -> None:
        """Manually reset the circuit breaker to closed state."""
        self._state = 'closed'
        self._failure_count = 0
        self._last_failure_time = None
        self._half_open_calls = 0

    def to_dict(self) -> dict[str, Any]:
        """Return circuit breaker state as a dictionary for observability."""
        return {
            'service_name': self.service_name,
            'state': self.state,
            'failure_count': self._failure_count,
            'failure_threshold': self.failure_threshold,
            'recovery_timeout': self.recovery_timeout,
        }
