# Community edition stub — warm intro paths is available in WarmReach Pro.
from shared_services.base_service import BaseService


class WarmIntroPathsService(BaseService):
    def __init__(self, table):
        super().__init__()
        self.table = table

    def find_paths(self, requesting_user_id, target_profile_id_b64, max_hops=3, max_paths=3):
        return {
            'paths': [],
            'targetProfileId': target_profile_id_b64,
            'generatedAt': '',
        }
