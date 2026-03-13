"""TypedDict definitions for DynamoDB single-table item shapes.

Each TypedDict corresponds to a PK/SK access pattern. All items share
PK and SK fields; item-specific fields are documented with their
access patterns.
"""

from typing import Any, TypedDict


class TierItem(TypedDict, total=False):
    """USER#{sub} | TIER#current"""

    PK: str
    SK: str
    tier: str
    quotas: dict[str, int]
    features: dict[str, bool]
    createdAt: str
    updatedAt: str
    stripeCustomerId: str
    stripeSubscriptionId: str


class UsageCounterItem(TypedDict, total=False):
    """USER#{sub} | USAGE#daily#{date} or USAGE#monthly#{month}"""

    PK: str
    SK: str
    count: int
    ttl: int
    operation: str


class SettingsItem(TypedDict, total=False):
    """USER#{sub} | #SETTINGS"""

    PK: str
    SK: str


class ProfileMetadataItem(TypedDict, total=False):
    """PROFILE#{id} | #METADATA"""

    PK: str
    SK: str
    name: str
    currentTitle: str
    currentCompany: str
    currentLocation: str
    headline: str
    summary: str
    skills: list[str]
    originalUrl: str
    profilePictureUrl: str


class UserProfileEdgeItem(TypedDict, total=False):
    """USER#{sub} | PROFILE#{id}"""

    PK: str
    SK: str
    status: str
    addedAt: str
    updatedAt: str
    messages: list[dict[str, Any]]
    GSI1PK: str
    GSI1SK: str
    processedAt: str
    ragstack_ingested: bool
    ragstack_ingested_at: str
    ragstack_document_id: str
    relationshipScore: float
    scoreBreakdown: dict[str, Any]
    scoreComputedAt: str


class ProfileUserEdgeItem(TypedDict, total=False):
    """PROFILE#{id} | USER#{sub}"""

    PK: str
    SK: str
    status: str
    addedAt: str
    updatedAt: str
    lastAttempt: str
    attempts: int


class InsightsMessagingItem(TypedDict, total=False):
    """USER#{sub} | INSIGHTS#messaging"""

    PK: str
    SK: str
    stats: dict[str, Any]
    computedAt: str
    sampleMessages: list[dict[str, Any]]
    insights: list[str]
    insightsUpdatedAt: str
    ttl: int


class InsightsPriorityItem(TypedDict, total=False):
    """USER#{sub} | INSIGHTS#priority"""

    PK: str
    SK: str
    recommendations: list[dict[str, Any]]
    totalEligible: int
    computedAt: str
    ttl: int


class CommandItem(TypedDict, total=False):
    """COMMAND#{id} | #METADATA"""

    PK: str
    SK: str
    status: str
    commandType: str
    payload: dict[str, Any]
    createdAt: str
    updatedAt: str
    userId: str
    connectionId: str


class WebSocketConnectionItem(TypedDict, total=False):
    """WSCONN#{id} | #METADATA"""

    PK: str
    SK: str
    userId: str
    connectedAt: str
    ttl: int


class StripeMappingItem(TypedDict, total=False):
    """STRIPE#{customerId} | #MAPPING"""

    PK: str
    SK: str
    userSub: str


class WebhookItem(TypedDict, total=False):
    """WEBHOOK#{eventId} | ..."""

    PK: str
    SK: str
    processedAt: str


class CircuitBreakerStateItem(TypedDict, total=False):
    """CB#{service} | STATE"""

    PK: str
    SK: str
    state: str
    failure_count: int
    last_failure_time: str
    last_success_time: str


class RateLimitConfigItem(TypedDict, total=False):
    """GLOBAL#config | RATELIMIT#{tier}"""

    PK: str
    SK: str
    rateLimits: dict[str, Any]


class DailyScrapeCountItem(TypedDict, total=False):
    """USER#{sub} | #DAILY_SCRAPE_COUNT#{YYYY-MM-DD}"""

    PK: str
    SK: str
    count: int
    ttl: int


class ImportCheckpointItem(TypedDict, total=False):
    """USER#{sub} | #IMPORT_CHECKPOINT"""

    PK: str
    SK: str
    batchIndex: int
    lastProfileId: str
    connectionType: str
    processedCount: int
    totalCount: int
    updatedAt: str
    ttl: int


class IngestStateItem(TypedDict, total=False):
    """PROFILE#{id} | #INGEST_STATE"""

    PK: str
    SK: str
    ingested_at: str
    document_id: str
    ttl: int


class RateLimitCounterItem(TypedDict, total=False):
    """USER#{sub} | RATELIMIT#cmd#{window}"""

    PK: str
    SK: str
    count: int
    ttl: int
