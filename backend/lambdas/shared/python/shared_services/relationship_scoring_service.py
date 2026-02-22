# Community edition stub — relationship scoring is available in WarmReach Pro.
from shared_services.base_service import BaseService


class RelationshipScoringService(BaseService):
    def compute_score(self, edge_item, profile_metadata):
        return {'score': 0, 'breakdown': {}}

    def compute_batch_scores(self, edges, profile_metadata_map):
        return []
