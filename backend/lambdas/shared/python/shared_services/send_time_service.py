# Community edition stub — best time to send is available in WarmReach Pro.
from shared_services.base_service import BaseService


class SendTimeService(BaseService):
    def compute_send_time_recommendations(self, edges):
        return {
            'globalRecommendations': {
                'bestHours': [],
                'bestDays': [],
                'sampleSize': 0,
            },
            'perConnectionRecommendations': [],
        }
