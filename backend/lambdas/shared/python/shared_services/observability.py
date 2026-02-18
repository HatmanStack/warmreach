"""Structured observability for Lambda functions.

Provides correlation ID tracking and structured JSON logging across
Lambda invocations for distributed tracing.
"""

import json
import logging
import uuid
from typing import Any


class CorrelationContext:
    """Thread-local correlation context for request tracing."""

    _trace_id: str | None = None
    _lambda_name: str | None = None

    @classmethod
    def get_trace_id(cls) -> str:
        """Get current trace ID, generating one if not set."""
        if cls._trace_id is None:
            cls._trace_id = str(uuid.uuid4())
        return cls._trace_id

    @classmethod
    def set_trace_id(cls, trace_id: str) -> None:
        cls._trace_id = trace_id

    @classmethod
    def set_lambda_name(cls, name: str) -> None:
        cls._lambda_name = name


class StructuredLogFilter(logging.Filter):
    """Injects correlation context into all log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = CorrelationContext.get_trace_id()  # type: ignore[attr-defined]
        record.lambda_name = CorrelationContext._lambda_name or 'unknown'  # type: ignore[attr-defined]
        return True


class StructuredJsonFormatter(logging.Formatter):
    """Formats log records as structured JSON for CloudWatch Logs Insights."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict[str, Any] = {
            'timestamp': self.formatTime(record),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'trace_id': getattr(record, 'trace_id', None),
            'lambda': getattr(record, 'lambda_name', None),
        }

        # Include exception info if present
        if record.exc_info and record.exc_info[0]:
            log_entry['exception'] = {
                'type': record.exc_info[0].__name__,
                'message': str(record.exc_info[1]),
            }

        # Include extra fields passed via logger.info('msg', extra={...})
        for key in ('user_id', 'operation', 'duration_ms', 'status_code'):
            if hasattr(record, key):
                log_entry[key] = getattr(record, key)

        return json.dumps(log_entry, default=str)


def setup_correlation_context(event: dict[str, Any], context: Any) -> str:
    """
    Initialize correlation context from API Gateway event.

    Extracts X-Trace-Id from request headers or generates a new one.
    Sets up structured logging for the current invocation.

    Args:
        event: Lambda event (API Gateway format)
        context: Lambda context

    Returns:
        The trace ID being used for this invocation
    """
    # Extract trace ID from headers or generate new one
    headers = event.get('headers') or {}
    trace_id = (
        headers.get('x-trace-id') or headers.get('X-Trace-Id') or headers.get('x-request-id') or str(uuid.uuid4())
    )

    CorrelationContext.set_trace_id(trace_id)

    # Set lambda name from context
    lambda_name = getattr(context, 'function_name', None) or 'unknown'
    CorrelationContext.set_lambda_name(lambda_name)

    # Configure root logger with structured formatting
    root_logger = logging.getLogger()

    # Add filter to root logger if not already added
    if not any(isinstance(f, StructuredLogFilter) for f in root_logger.filters):
        root_logger.addFilter(StructuredLogFilter())

    # Replace handlers with structured JSON formatter
    formatter = StructuredJsonFormatter()
    for handler in root_logger.handlers:
        handler.setFormatter(formatter)

    return trace_id
