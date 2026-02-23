# Community edition stub — reply probability is available in WarmReach Pro.
from shared_services.base_service import BaseService


class ReplyProbabilityService(BaseService):
    def compute_reply_probabilities(self, edges, profile_metadata_map=None):
        return []

    def compute_single_probability(self, edge_item, profile_metadata=None):
        return {'replyProbability': 0, 'confidence': 'low', 'factors': {}}
