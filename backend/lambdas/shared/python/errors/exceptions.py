"""Custom exception classes for service layer."""


class ServiceError(Exception):
    """
    Base exception for all service layer errors.

    Attributes:
        code: Error code for client identification
        message: Human-readable error message
        details: Optional additional error details
    """

    def __init__(self, message: str, code: str = 'SERVICE_ERROR', details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.details = details or {}

    def to_dict(self) -> dict:
        """Convert exception to dictionary for JSON response."""
        result = {
            'code': self.code,
            'message': self.message,
        }
        if self.details:
            result['details'] = self.details
        return result


class ValidationError(ServiceError):
    """Raised when input validation fails."""

    def __init__(self, message: str, field: str | None = None, details: dict | None = None):
        code = 'VALIDATION_ERROR'
        if field:
            details = details or {}
            details['field'] = field
        super().__init__(message, code, details)


class NotFoundError(ServiceError):
    """Raised when a requested resource is not found."""

    def __init__(self, message: str, resource_type: str | None = None, resource_id: str | None = None):
        code = 'NOT_FOUND'
        details = {}
        if resource_type:
            details['resource_type'] = resource_type
        if resource_id:
            details['resource_id'] = resource_id
        super().__init__(message, code, details if details else None)


class AuthorizationError(ServiceError):
    """Raised when user is not authorized to perform an action."""

    def __init__(self, message: str = 'Unauthorized', details: dict | None = None):
        super().__init__(message, 'UNAUTHORIZED', details)


class ExternalServiceError(ServiceError):
    """Raised when an external service (AWS, OpenAI, etc.) fails."""

    def __init__(self, message: str, service: str, original_error: str | None = None):
        details = {'service': service}
        if original_error:
            details['original_error'] = original_error
        super().__init__(message, 'EXTERNAL_SERVICE_ERROR', details)


class ConfigurationError(ServiceError):
    """Raised when required configuration is missing or invalid."""

    def __init__(self, message: str, config_key: str | None = None):
        details = {}
        if config_key:
            details['config_key'] = config_key
        super().__init__(message, 'CONFIGURATION_ERROR', details if details else None)


class QuotaExceededError(ServiceError):
    """Raised when a usage quota has been exceeded."""

    def __init__(self, message: str = 'Quota exceeded', operation: str | None = None):
        details = {}
        if operation:
            details['operation'] = operation
        super().__init__(message, 'QUOTA_EXCEEDED', details if details else None)
