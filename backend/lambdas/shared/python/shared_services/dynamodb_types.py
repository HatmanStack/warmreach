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
    notificationPreference: str  # "urgent" | "warning" | "all"


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


# --- Service method return types ---


class LinkedInInteractionLimits(TypedDict):
    """Rate limit status for LinkedIn interactions."""

    daily_limit: int
    hourly_limit: int
    current_daily: int
    current_hourly: int


class RateLimitsResult(TypedDict):
    """Return type for QuotaService.get_rate_limits()."""

    linkedin_interactions: LinkedInInteractionLimits


class QuotaStatusResult(TypedDict):
    """Return type for QuotaService.get_quota_status()."""

    allowed: bool
    remaining: int
    dailyLimit: int
    monthlyRemaining: int
    monthlyLimit: int


class FeatureFlagResult(TypedDict):
    """Return type for FeatureFlagService.get_feature_flags()."""

    tier: str
    features: dict[str, bool]
    quotas: dict[str, int]
    rateLimits: dict[str, Any]


# --- Analytics service return types ---


class FunnelCounts(TypedDict):
    """Stage counts within the connection funnel."""

    possible: int
    outgoing: int
    ally: int
    processed: int


class ConversionRates(TypedDict):
    """Stage-to-stage conversion rates."""

    possibleToOutgoing: float
    outgoingToAlly: float
    overallConversion: float


class ConnectionFunnelResult(TypedDict):
    """Return type for AnalyticsService.get_connection_funnel()."""

    funnel: FunnelCounts
    conversionRates: ConversionRates
    total: int


class GrowthTimelineEntry(TypedDict):
    """Single day in the growth timeline."""

    date: str
    added: int
    cumulative: int


class GrowthTimelineResult(TypedDict):
    """Return type for AnalyticsService.get_growth_timeline()."""

    timeline: list[GrowthTimelineEntry]
    period: int
    totalGrowth: int
    avgDailyGrowth: float


class EngagementTimelineEntry(TypedDict):
    """Single day in the engagement timeline."""

    date: str
    outbound: int
    inbound: int


class EngagementTotals(TypedDict):
    """Totals section of engagement metrics."""

    outbound: int
    inbound: int
    responseRate: float


class EngagementMetricsResult(TypedDict):
    """Return type for AnalyticsService.get_engagement_metrics()."""

    timeline: list[EngagementTimelineEntry]
    totals: EngagementTotals
    period: int


class UsageDailyTrendEntry(TypedDict):
    """Single day in the usage daily trend."""

    date: str
    total: int


class UsageSummaryResult(TypedDict):
    """Return type for AnalyticsService.get_usage_summary()."""

    byOperation: dict[str, int]
    dailyTrend: list[UsageDailyTrendEntry]
    totalOperations: int
    period: int


class DashboardSummaryResult(TypedDict):
    """Return type for AnalyticsService.get_dashboard_summary()."""

    funnel: ConnectionFunnelResult
    growth: GrowthTimelineResult
    engagement: EngagementMetricsResult
    usage: UsageSummaryResult
    generatedAt: str


# --- Relationship scoring return types ---


class ScoreBreakdown(TypedDict):
    """Component scores within a relationship score."""

    frequency: int
    recency: int
    reciprocity: int
    profile_completeness: int
    depth: int


class RelationshipScoreResult(TypedDict):
    """Return type for RelationshipScoringService.compute_score()."""

    score: int
    breakdown: ScoreBreakdown


class BatchScoreEntry(TypedDict):
    """Single entry in batch score results."""

    profileId: str
    score: int
    breakdown: ScoreBreakdown


# --- Goal intelligence types ---


class EvidenceEntry(TypedDict, total=False):
    """Single evidence entry within an opportunity's evidence log."""

    id: str
    source: str  # one of: manual, activity, github, blog, external
    title: str
    description: str
    date: str  # ISO 8601
    links: list[str]
    metadata: dict[str, Any]
    addedAt: str  # ISO 8601


class CadenceAlert(TypedDict, total=False):
    """A cadence alert for a tagged connection needing follow-up."""

    profileId: str
    reason: str
    severity: str  # one of: info, warning, urgent
    lastInteraction: str  # ISO 8601


class NotificationItem(TypedDict, total=False):
    """USER#{sub} | NOTIFICATION#{timestamp}#{id}"""

    PK: str
    SK: str
    type: str
    severity: str  # one of: info, warning, urgent
    title: str
    body: str
    payload: dict[str, Any]
    read: bool
    readAt: str
    createdAt: str
    ttl: int


class GoalAssessment(TypedDict, total=False):
    """LLM-cached assessment of goal progress."""

    summary: str
    gaps: list[str]
    recommendations: list[str]
    cadenceAlerts: list[CadenceAlert]
    nextSteps: list[str]
    checklistUpdates: list['ChecklistUpdate']
    updatedAt: str  # ISO 8601
    modelVersion: str


class RequirementItem(TypedDict, total=False):
    """Single requirement within an opportunity's checklist."""

    id: str  # UUID
    title: str
    type: str  # "boolean" or "counter"
    target: int  # For counter: target count; 1 for boolean
    current: int  # For counter: current count; 0 or 1 for boolean
    completed: bool
    completedAt: str  # ISO 8601, None when not completed
    addedBy: str  # "llm" or "user"
    linkedEvidence: list[str]  # Evidence entry IDs


class ChecklistUpdate(TypedDict, total=False):
    """A single checklist mutation from LLM assessment output."""

    action: str  # "complete" | "add" | "modify" | "remove"
    id: str  # Existing requirement ID (for complete/modify/remove)
    title: str  # For add/modify
    type: str  # For add: "boolean" or "counter"
    target: int  # For add/modify
    current: int  # For modify
    linkedEvidence: list[str]  # Evidence IDs
