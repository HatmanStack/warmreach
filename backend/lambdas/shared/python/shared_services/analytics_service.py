# Community edition stub — advanced analytics is available in WarmReach Pro.
from shared_services.base_service import BaseService
from shared_services.dynamodb_types import (
    ConnectionFunnelResult,
    DashboardSummaryResult,
    EngagementMetricsResult,
    GrowthTimelineResult,
    UsageSummaryResult,
)

# The return annotations mirror the pro service's. `backend/pyproject.toml` syncs
# verbatim and no longer excludes this module from mypy, so both editions are now
# checked against the same contract. Annotating it surfaced two returns that did
# not satisfy their own declared type — `get_connection_funnel` returned bare `{}`
# for `funnel`/`conversionRates`, and `get_dashboard_summary` returned `{}` outright
# — so a community consumer indexing either would have hit a KeyError that pro never
# produces. They now return the zero-valued shape.


class AnalyticsService(BaseService):
    def __init__(self, table):
        super().__init__()

    def get_connection_funnel(self, user_id: str, edges: list[dict] | None = None) -> ConnectionFunnelResult:
        return {
            'funnel': {'possible': 0, 'outgoing': 0, 'ally': 0, 'processed': 0},
            'conversionRates': {'possibleToOutgoing': 0.0, 'outgoingToAlly': 0.0, 'overallConversion': 0.0},
            'total': 0,
        }

    def get_growth_timeline(
        self, user_id: str, days: int = 30, edges: list[dict] | None = None
    ) -> GrowthTimelineResult:
        return {'timeline': [], 'period': days, 'totalGrowth': 0, 'avgDailyGrowth': 0}

    def get_engagement_metrics(
        self, user_id: str, days: int = 30, edges: list[dict] | None = None
    ) -> EngagementMetricsResult:
        return {
            'timeline': [],
            'totals': {'outbound': 0, 'inbound': 0, 'responseRate': 0.0},
            'period': days,
        }

    def get_usage_summary(self, user_id: str, days: int = 30) -> UsageSummaryResult:
        return {'byOperation': {}, 'dailyTrend': [], 'totalOperations': 0, 'period': days}

    def get_dashboard_summary(self, user_id: str, days: int = 30) -> DashboardSummaryResult:
        return {
            'funnel': self.get_connection_funnel(user_id),
            'growth': self.get_growth_timeline(user_id, days),
            'engagement': self.get_engagement_metrics(user_id, days),
            'usage': self.get_usage_summary(user_id, days),
            'generatedAt': '',
        }
