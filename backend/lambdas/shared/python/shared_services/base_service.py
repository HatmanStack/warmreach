"""Base service class with dependency injection pattern."""

import logging


class BaseService:
    """Base class for all service layer classes."""

    def __init__(self, logger_name: str | None = None):
        self.logger = logging.getLogger(logger_name or self.__class__.__name__)
