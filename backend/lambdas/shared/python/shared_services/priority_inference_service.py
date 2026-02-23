# Community edition stub — priority inference is available in WarmReach Pro.
from shared_services.base_service import BaseService


class PriorityInferenceService(BaseService):
    def compute_priority_recommendations(self, edges, reply_probabilities=None, limit=20):
        return {
            'recommendations': [],
            'generatedAt': '',
            'totalEligible': 0,
        }
