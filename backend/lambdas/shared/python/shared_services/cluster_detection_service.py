# Community edition stub — cluster detection is available in WarmReach Pro.
from shared_services.base_service import BaseService


class ClusterDetectionService(BaseService):
    def detect_clusters(self, edges, min_cluster_size=2):
        return {
            'clusters': [],
            'unclustered': 0,
            'totalConnections': 0,
            'generatedAt': '',
        }
