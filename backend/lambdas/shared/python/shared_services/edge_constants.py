"""Shared constants and helpers for edge services.

These were originally defined in edge_data_service.py. They are re-exported
from edge_data_service for backward compatibility.
"""

import base64


def encode_profile_id(profile_id: str) -> str:
    """URL-safe base64 encode a profile ID for use as a DynamoDB key component."""
    return base64.urlsafe_b64encode(profile_id.encode()).decode()


# Statuses that trigger RAGStack ingestion
INGESTION_TRIGGER_STATUSES = {'outgoing', 'ally', 'followed'}

# Maximum messages stored per edge
MAX_MESSAGES_PER_EDGE = 100

# Maximum notes stored per edge
MAX_NOTES_PER_EDGE = 50

# Maximum note content length
MAX_NOTE_LENGTH = 1000

# Opportunity pipeline stages
OPPORTUNITY_STAGES = ['identified', 'reached_out', 'replied', 'met', 'outcome']

# Opportunity outcome sub-statuses
OPPORTUNITY_OUTCOMES = ['won', 'lost', 'stalled']
