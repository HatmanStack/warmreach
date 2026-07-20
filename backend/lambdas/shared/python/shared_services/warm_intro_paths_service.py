# Community edition stub — warm intro paths is available in WarmReach Pro.
#
# The Pro service traverses the requester's own private contact-to-contact
# adjacency (you -> your contact -> ... -> target). The community edition ships
# no adjacency store, so this stub returns an empty, interface-compatible
# result. The signature and top-level response keys match the Pro service so
# callers (and the frontend) consume an identical shape.
from shared_services.base_service import BaseService

DEFAULT_MAX_QUEUE_SIZE = 1000


class WarmIntroPathsService(BaseService):
    def __init__(self, table):
        super().__init__()
        self.table = table

    def find_paths(
        self,
        requesting_user_id,
        target_profile_id_b64,
        max_hops=3,
        max_paths=3,
        max_queue_size=DEFAULT_MAX_QUEUE_SIZE,
    ):
        return {
            'paths': [],
            'targetProfileId': target_profile_id_b64,
            'generatedAt': '',
        }
