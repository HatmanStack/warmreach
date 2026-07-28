# Community edition stub — relationship scoring is available in WarmReach Pro.
from shared_services.base_service import BaseService
from shared_services.dynamodb_types import BatchScoreEntry, RelationshipScoreResult

# The return annotations mirror the pro service's. `backend/pyproject.toml` syncs
# verbatim and no longer excludes this module from mypy, so both editions are now
# checked against the same contract — which is the point of a stub. Annotating it
# surfaced a real divergence: `breakdown` was `{}`, and `ScoreBreakdown` is a total
# TypedDict, so a community consumer reading `breakdown['frequency']` would have
# hit a KeyError that pro never produces.


class RelationshipScoringService(BaseService):
    def compute_score(self, edge_item: dict, profile_metadata: dict) -> RelationshipScoreResult:
        return {
            'score': 0,
            'breakdown': {
                'frequency': 0,
                'recency': 0,
                'reciprocity': 0,
                'profile_completeness': 0,
                'depth': 0,
            },
        }

    def compute_batch_scores(self, edges: list[dict], profile_metadata_map: dict) -> list[BatchScoreEntry]:
        return []
