"""Monetization stubs — no-op replacements for the community edition.

All Lambda code imports from ``shared_services.monetization``. In the
community edition every call succeeds and all features are enabled.
"""


class QuotaService:
    """No-op quota service — every call succeeds."""

    def __init__(self, table):
        self.table = table

    def report_usage(self, user_sub, operation, *, count=1):
        pass

    def get_rate_limits(self, user_sub):
        return {
            'linkedin_interactions': {
                'daily_limit': 999999,
                'daily_used': 0,
                'hourly_limit': 999999,
                'hourly_used': 0,
            }
        }


class FeatureFlagService:
    """No-op feature-flag service — all features enabled."""

    def __init__(self, table):
        self.table = table

    def get_feature_flags(self, user_sub):
        return {
            'tier': 'community',
            'features': {
                'ai_messaging': True,
                'bulk_operations': True,
                'advanced_analytics': True,
                'priority_support': True,
                'deep_research': True,
            },
            'quotas': {},
            'rateLimits': {},
        }


def ensure_tier_exists(table, user_sub):
    """No-op tier provisioning — returns community tier."""
    return {'tier': 'community'}


# Re-export the real exception class so isinstance() checks work correctly
# when tests or other code import from errors.exceptions directly.
from errors.exceptions import QuotaExceededError  # noqa: F401
