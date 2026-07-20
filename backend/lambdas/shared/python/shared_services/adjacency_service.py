"""AdjacencyService - Private per-user contact-to-contact adjacency store.

Stores the missing PROFILE<->PROFILE relationship: for each user, an undirected
contact-to-contact edge is persisted under that user's *own* DynamoDB partition
as two directed rows written in a single ``transact_write_items``::

    PK=USER#{user_id}  SK=ADJ#{a}#{b}
    PK=USER#{user_id}  SK=ADJ#{b}#{a}

Load-bearing invariants (ADR-1):

1. All neighbors of any node ``n`` are retrievable with a single base-table query
   ``PK=USER#{user_id} AND begins_with(SK, 'ADJ#{n}#')`` -- no new GSI, no change
   to ``template.yaml``.
2. Every read and write stays within ``PK=USER#{user_id}``; one user's inferred
   graph can never leak into another's partition. This is what makes the mesh
   leak-proof by construction.
3. Writes are idempotent: ``observedAt`` is preserved via ``if_not_exists`` while
   ``updatedAt``, ``strength`` and ``mutualCount`` refresh on every write.

Node ids are treated as opaque strings: the value passed in is stored verbatim in
the sort key and returned verbatim from :meth:`get_neighbors`. Callers supply the
canonical (base64-encoded) profile id so adjacency rows join cleanly against the
forward ``PROFILE#{id}`` edges during pathfinding. The two directed rows make the
write order-independent: ``upsert(a, b)`` and ``upsert(b, a)`` converge to the
same pair of rows.
"""

import logging
from datetime import UTC, datetime
from typing import Any

import boto3
from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from shared_services.base_service import BaseService

logger = logging.getLogger(__name__)

# Neutral tie-strength recorded at collection time (Phase 0 Open Questions).
# The shared-connection surface exposes no reliable tie strength, so every
# collected edge carries the same constant; the displayed shared-connection
# count (when available) is stored separately as ``mutualCount`` metadata.
DEFAULT_ADJACENCY_STRENGTH = 50


def _coerce_number(value: Any) -> Any:
    """Coerce a DynamoDB numeric (Decimal) into a plain int/float for callers."""
    if value is None:
        return None
    number = float(value)
    return int(number) if number.is_integer() else number


class AdjacencyService(BaseService):
    """Stores and reads the per-user contact-to-contact adjacency."""

    def __init__(self, table, dynamodb_client=None):
        super().__init__()
        self.table = table
        self._dynamodb_client_override = dynamodb_client

    @property
    def _dynamodb_client(self):
        if self._dynamodb_client_override is None:
            self._dynamodb_client_override = boto3.client('dynamodb')
        return self._dynamodb_client_override

    def upsert_adjacency(
        self,
        user_id: str,
        node_a: str,
        node_b: str,
        strength: float = DEFAULT_ADJACENCY_STRENGTH,
        source: str = 'mutual',
        mutual_count: int | None = None,
    ) -> dict[str, Any]:
        """Idempotently upsert one undirected contact-to-contact edge.

        Writes both directed rows in a single ``transact_write_items`` under the
        owning user's partition. ``observedAt`` is preserved on re-observation;
        ``updatedAt``/``strength``/``mutualCount`` refresh every time.
        """
        if not user_id:
            raise ValidationError('user_id is required', field='user_id')
        if not node_a or not node_b:
            raise ValidationError('adjacency edge requires two node ids', field='node')
        if node_a == node_b:
            raise ValidationError('adjacency edge requires two distinct nodes', field='node')

        current_time = datetime.now(UTC).isoformat()
        table_name = self.table.table_name

        try:
            self._dynamodb_client.transact_write_items(
                TransactItems=[
                    self._directed_row_update(
                        table_name, user_id, node_a, node_b, current_time, strength, source, mutual_count
                    ),
                    self._directed_row_update(
                        table_name, user_id, node_b, node_a, current_time, strength, source, mutual_count
                    ),
                ]
            )
        except ClientError as e:
            if e.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
                logger.error(
                    'Adjacency transaction cancelled',
                    extra={
                        'user_id': user_id,
                        'cancellation_reasons': e.response.get('CancellationReasons', []),
                    },
                )
            else:
                logger.error('DynamoDB error in upsert_adjacency: %s', e)
            raise ExternalServiceError(
                message='Failed to upsert adjacency', service='DynamoDB', original_error=str(e)
            ) from e

        return {
            'success': True,
            'nodeA': node_a,
            'nodeB': node_b,
            'strength': strength,
        }

    def get_neighbors(self, user_id: str, node_id: str) -> list[tuple[str, Any]]:
        """Return ``[(neighbor_id, strength), ...]`` for ``node_id``.

        A single ``begins_with`` query scoped to ``PK=USER#{user_id}`` (never
        another user's partition). Returns an empty list for an unknown node.
        """
        if not user_id or not node_id:
            return []

        prefix = f'ADJ#{node_id}#'
        neighbors: list[tuple[str, Any]] = []
        params: dict[str, Any] = {
            'KeyConditionExpression': 'PK = :pk AND begins_with(SK, :sk)',
            'ExpressionAttributeValues': {':pk': f'USER#{user_id}', ':sk': prefix},
        }
        while True:
            response = self.table.query(**params)
            for item in response.get('Items', []):
                sk = item.get('SK', '')
                neighbor_id = sk[len(prefix) :]
                if not neighbor_id:
                    continue
                neighbors.append((neighbor_id, _coerce_number(item.get('strength'))))
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
            params['ExclusiveStartKey'] = last_key
        return neighbors

    def get_adjacency(self, user_id: str) -> dict[str, dict[str, Any]]:
        """Return the whole contact-to-contact mesh for a user.

        A single paginated ``begins_with(SK, 'ADJ#')`` query over the user's own
        partition (``PK=USER#{user_id}``) -- never another user's, so the mesh is
        leak-proof by construction. Returns ``{node_id: {neighbor_id: strength}}``.
        Because rows are dual-written, every endpoint appears as a top-level key,
        so the mapping is a complete, symmetric adjacency ready for traversal
        (network-graph edges, betweenness). Returns an empty dict for an unknown
        user or empty mesh.
        """
        if not user_id:
            return {}

        adjacency: dict[str, dict[str, Any]] = {}
        params: dict[str, Any] = {
            'KeyConditionExpression': 'PK = :pk AND begins_with(SK, :sk)',
            'ExpressionAttributeValues': {':pk': f'USER#{user_id}', ':sk': 'ADJ#'},
        }
        while True:
            response = self.table.query(**params)
            for item in response.get('Items', []):
                sk = item.get('SK', '')
                # SK shape: ADJ#{from}#{to}. Node ids are opaque base64 (no '#'),
                # so a plain split yields exactly three parts.
                parts = sk.split('#')
                if len(parts) != 3 or parts[0] != 'ADJ':
                    continue
                from_node, to_node = parts[1], parts[2]
                if not from_node or not to_node:
                    continue
                strength = _coerce_number(item.get('strength'))
                adjacency.setdefault(from_node, {})[to_node] = strength
                adjacency.setdefault(to_node, {})
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
            params['ExclusiveStartKey'] = last_key
        return adjacency

    def _directed_row_update(
        self,
        table_name: str,
        user_id: str,
        from_node: str,
        to_node: str,
        current_time: str,
        strength: float,
        source: str,
        mutual_count: int | None,
    ) -> dict[str, Any]:
        """Build one directed ``ADJ#`` row's idempotent Update for the transaction."""
        update_expr = (
            'SET observedAt = if_not_exists(observedAt, :now), updatedAt = :now, strength = :strength, #src = :source'
        )
        values: dict[str, Any] = {
            ':now': {'S': current_time},
            ':strength': {'N': str(strength)},
            ':source': {'S': source},
        }
        if mutual_count is not None:
            update_expr += ', mutualCount = :mutualCount'
            values[':mutualCount'] = {'N': str(mutual_count)}

        return {
            'Update': {
                'TableName': table_name,
                'Key': {
                    'PK': {'S': f'USER#{user_id}'},
                    'SK': {'S': f'ADJ#{from_node}#{to_node}'},
                },
                'UpdateExpression': update_expr,
                'ExpressionAttributeNames': {'#src': 'source'},
                'ExpressionAttributeValues': values,
            }
        }
