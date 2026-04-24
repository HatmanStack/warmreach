"""Enum definitions for the service layer."""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class ConversionLikelihood(StrEnum):
    """
    Conversion likelihood classification for connections.

    Replaces the percentage-based scoring (0-100) with a simple
    three-tier enum for clarity and maintainability.
    """

    HIGH = 'high'
    MEDIUM = 'medium'
    LOW = 'low'


def classify_conversion_likelihood(profile: dict[str, Any] | None, edge: dict[str, Any] | None) -> ConversionLikelihood:
    """
    Classify conversion likelihood based on profile completeness and edge data.

    Classification Rules (per ADR-002):
    - HIGH: Has headline AND summary AND (added < 7 days) AND (attempts == 0)
    - LOW: Missing headline OR missing summary OR (attempts > 2)
    - MEDIUM: Everything else

    Args:
        profile: Profile data dict with 'headline' and 'summary' fields
        edge: Edge data dict with 'date_added' and 'connection_attempts' fields

    Returns:
        ConversionLikelihood enum value
    """
    # Handle None inputs
    if profile is None:
        return ConversionLikelihood.LOW

    if edge is None:
        edge = {}

    # Check profile completeness
    headline = profile.get('headline', '').strip() if profile.get('headline') else ''
    summary = profile.get('summary', '').strip() if profile.get('summary') else ''

    has_headline = bool(headline)
    has_summary = bool(summary)

    # Check edge data
    connection_attempts = edge.get('connection_attempts', 0) or 0
    date_added_str = edge.get('date_added')

    # Parse date_added to check recency
    is_recent = False
    if date_added_str:
        try:
            # Handle ISO format datetime strings
            if isinstance(date_added_str, str):
                # Remove 'Z' suffix if present and replace with +00:00
                if date_added_str.endswith('Z'):
                    date_added_str = date_added_str[:-1] + '+00:00'
                date_added = datetime.fromisoformat(date_added_str)
            else:
                date_added = date_added_str

            # Ensure timezone aware
            if date_added.tzinfo is None:
                date_added = date_added.replace(tzinfo=UTC)

            days_since_added = (datetime.now(UTC) - date_added).days
            is_recent = days_since_added < 7
        except (ValueError, TypeError):
            # If date parsing fails, don't count as recent
            is_recent = False

    # Apply classification rules
    # LOW conditions: Missing profile data or too many attempts
    if not has_headline or not has_summary:
        return ConversionLikelihood.LOW

    if connection_attempts > 2:
        return ConversionLikelihood.LOW

    # HIGH conditions: Complete profile + recent + no attempts
    if has_headline and has_summary and is_recent and connection_attempts == 0:
        return ConversionLikelihood.HIGH

    # MEDIUM: Everything else
    return ConversionLikelihood.MEDIUM
