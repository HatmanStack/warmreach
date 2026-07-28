# Community edition stub — best time to send is available in WarmReach Pro.
from typing import Any

from shared_services.base_service import BaseService

# Annotated to match the pro signature: `backend/pyproject.toml` syncs verbatim and
# no longer excludes this module from mypy, so this file is checked in both editions.


class SendTimeService(BaseService):
    def compute_send_time_recommendations(self, edges: list[dict]) -> dict[str, Any]:
        return {
            'globalRecommendations': {
                'bestHours': [],
                'bestDays': [],
                'sampleSize': 0,
            },
            'perConnectionRecommendations': [],
        }
