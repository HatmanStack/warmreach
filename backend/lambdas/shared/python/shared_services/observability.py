"""Structured observability for Lambda functions.

Provides correlation ID tracking and structured JSON logging across
Lambda invocations for distributed tracing.
"""

import contextvars
import json
import logging
import uuid
from typing import Any

# Context variables for execution-scoped state
_trace_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar('trace_id', default=None)
_lambda_name_var: contextvars.ContextVar[str | None] = contextvars.ContextVar('lambda_name', default=None)


class CorrelationContext:
    """Execution-scoped correlation context for request tracing using contextvars."""

    @classmethod
    def get_trace_id(cls) -> str:
        """Get current trace ID, generating one if not set."""
        trace_id = _trace_id_var.get()
        if trace_id is None:
            trace_id = str(uuid.uuid4())
            _trace_id_var.set(trace_id)
        return trace_id

    @classmethod
    def set_trace_id(cls, trace_id: str) -> None:
        _trace_id_var.set(trace_id)

    @classmethod
    def set_lambda_name(cls, name: str) -> None:
        _lambda_name_var.set(name)

    @classmethod
    def get_lambda_name(cls) -> str:
        return _lambda_name_var.get() or 'unknown'


class StructuredLogFilter(logging.Filter):
    """Injects correlation context into all log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = CorrelationContext.get_trace_id()  # type: ignore[attr-defined]
        record.lambda_name = CorrelationContext.get_lambda_name()  # type: ignore[attr-defined]
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
