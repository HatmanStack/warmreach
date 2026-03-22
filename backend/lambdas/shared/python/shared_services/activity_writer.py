"""Activity writer - fire-and-forget DynamoDB activity record writer.

Writes activity records for timeline display. Never raises exceptions -
all errors are caught and logged as warnings.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from enum import StrEnum

logger = logging.getLogger(__name__)

# Activity records expire after 90 days
ACTIVITY_TTL_DAYS = 90


class ActivityEventType(StrEnum):
    """Event types for activity timeline records."""

    CONNECTION_STATUS_CHANGE = 'connection_status_change'
    MESSAGE_SENT = 'message_sent'
    COMMAND_DISPATCHED = 'command_dispatched'
    AI_MESSAGE_GENERATED = 'ai_message_generated'
    AI_TONE_ANALYSIS = 'ai_tone_analysis'
    AI_DEEP_RESEARCH = 'ai_deep_research'
    PROFILE_METADATA_UPDATED = 'profile_metadata_updated'
    USER_SETTINGS_UPDATED = 'user_settings_updated'
    NOTE_ADDED = 'note_added'
    PROFILE_INGESTED = 'profile_ingested'
    LIFECYCLE_CHANGE = 'lifecycle_change'
    OPPORTUNITY_CREATED = 'opportunity_created'
    OPPORTUNITY_STAGE_CHANGED = 'opportunity_stage_changed'
    OPPORTUNITY_ARCHIVED = 'opportunity_archived'
    OPPORTUNITY_COMPLETED = 'opportunity_completed'
    ICEBREAKER_GENERATED = 'icebreaker_generated'
    ONBOARDING_STEP_COMPLETED = 'onboarding_step_completed'
    ONBOARDING_COMPLETED = 'onboarding_completed'
    ONBOARDING_SKIPPED = 'onboarding_skipped'
    SUBSCRIPTION_CANCELLED = 'subscription_cancelled'
    SUBSCRIPTION_RESUBSCRIBED = 'subscription_resubscribed'


def write_activity(
    table,
    user_id: str,
    event_type: str,
    metadata: dict | None = None,
) -> None:
    """Write an activity record to DynamoDB. Fire-and-forget - never raises."""
    try:
        timestamp = datetime.now(UTC).isoformat()
        sk = f'ACTIVITY#{timestamp}#{event_type}#{uuid.uuid4()}'

        ttl = int((datetime.now(UTC) + timedelta(days=ACTIVITY_TTL_DAYS)).timestamp())

        item = {
            'PK': f'USER#{user_id}',
            'SK': sk,
            'eventType': event_type,
            'timestamp': timestamp,
            'ttl': ttl,
        }

        if metadata is not None:
            item['metadata'] = metadata

        table.put_item(Item=item)

    except Exception as e:
        logger.warning(f'Failed to write activity record: {e}')
