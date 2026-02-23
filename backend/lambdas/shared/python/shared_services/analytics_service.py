# Community edition stub — advanced analytics is available in WarmReach Pro.
from shared_services.base_service import BaseService


class AnalyticsService(BaseService):
    def __init__(self, table):
        super().__init__()

    def get_connection_funnel(self, user_id, edges=None):
        return {'funnel': {}, 'conversionRates': {}, 'total': 0}

    def get_growth_timeline(self, user_id, days=30, edges=None):
        return {'timeline': [], 'period': days, 'totalGrowth': 0, 'avgDailyGrowth': 0}

    def get_engagement_metrics(self, user_id, days=30, edges=None):
        return {'timeline': [], 'totals': {}, 'period': days}

    def get_usage_summary(self, user_id, days=30):
        return {'byOperation': {}, 'dailyTrend': [], 'totalOperations': 0, 'period': days}

    def get_dashboard_summary(self, user_id, days=30):
        return {}
