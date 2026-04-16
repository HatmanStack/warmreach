"""Error handling utilities for Lambda handlers."""

import json
import logging
from typing import Any

from .exceptions import (
    AuthorizationError,
    NotFoundError,
    ServiceError,
    ValidationError,
)

logger = logging.getLogger(__name__)

# Map exception types to HTTP status codes
STATUS_CODE_MAP = {
    ValidationError: 400,
    AuthorizationError: 401,
    NotFoundError: 404,
    ServiceError: 500,
}


def build_error_response(exception: ServiceError, headers: dict | None = None) -> dict[str, Any]:
    """
    Convert a ServiceError to an HTTP response dict.

    Args:
        exception: The ServiceError to convert
        headers: Optional headers to include in response

    Returns:
        Dict suitable for Lambda response with statusCode, headers, body
    """
    # Determine status code based on exception type
    status_code = 500
    for exc_type, code in STATUS_CODE_MAP.items():
        if isinstance(exception, exc_type):
            status_code = code
            break

    # Build response body
    body = {'error': exception.to_dict()}

    # Default headers
    response_headers = {
        'Content-Type': 'application/json',
    }
    if headers:
        response_headers.update(headers)

    return {
        'statusCode': status_code,
        'headers': response_headers,
        'body': json.dumps(body),
    }


def handle_service_error(exception: Exception, operation: str, cors_headers: dict | None = None) -> dict[str, Any]:
    """
    Handle any exception and convert to HTTP response.

    For ServiceError subclasses, uses appropriate status code.
    For other exceptions, returns 500 with generic message.

    Args:
        exception: The exception to handle
        operation: Name of operation for logging context
        cors_headers: Optional CORS headers to include

    Returns:
        Dict suitable for Lambda response
    """
    if isinstance(exception, ServiceError):
        logger.warning(
            'Service error in %s: %s - %s',
            operation,
            exception.code,
            exception.message,
            extra={'error_details': exception.details},
        )
        return build_error_response(exception, cors_headers)

    # Unexpected error - log full traceback
    logger.exception('Unexpected error in %s: %s', operation, exception)

    # Return generic error to client
    generic_error = ServiceError(message='An internal error occurred', code='INTERNAL_ERROR')
    return build_error_response(generic_error, cors_headers)
