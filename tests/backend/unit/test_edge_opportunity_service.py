"""Tests for bounded-retry optimistic concurrency in EdgeOpportunityService."""

from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError


def _service_module():
    from shared_services import edge_opportunity_service
    return edge_opportunity_service


def _make_service(table):
    mod = _service_module()
    queries_svc = MagicMock()
    return mod.EdgeOpportunityService(table, queries_svc)


def _ccf_error():
    return ClientError(
        {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'conflict'}},
        'UpdateItem',
    )


class TestBoundedRetry:
    def test_succeeds_after_two_conflicts(self, monkeypatch):
        mod = _service_module()
        monkeypatch.setattr(mod.time, 'sleep', lambda *_: None)

        table = MagicMock()
        table.get_item.return_value = {'Item': {'opportunities': [], 'updatedAt': '2026-01-01'}}
        # First 2 update_item calls raise, third succeeds.
        table.update_item.side_effect = [_ccf_error(), _ccf_error(), None]

        svc = _make_service(table)
        result = svc.tag_connection_to_opportunity('user-1', 'cHJvZmlsZQ==', 'opp-1', 'identified')
        assert result['success'] is True
        assert table.update_item.call_count == 3

    def test_raises_after_max_retries(self, monkeypatch):
        mod = _service_module()
        monkeypatch.setattr(mod.time, 'sleep', lambda *_: None)

        table = MagicMock()
        table.get_item.return_value = {'Item': {'opportunities': [], 'updatedAt': '2026-01-01'}}
        table.update_item.side_effect = _ccf_error()

        svc = _make_service(table)
        with pytest.raises(mod.OptimisticConcurrencyError):
            svc.tag_connection_to_opportunity('user-1', 'cHJvZmlsZQ==', 'opp-1', 'identified')
        assert table.update_item.call_count == mod.MAX_RETRIES

    def test_non_conditional_error_propagates_without_retry(self, monkeypatch):
        """Random DDB errors should not be retried."""
        mod = _service_module()
        monkeypatch.setattr(mod.time, 'sleep', lambda *_: None)

        table = MagicMock()
        table.get_item.return_value = {'Item': {'opportunities': [], 'updatedAt': '2026-01-01'}}
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
            'UpdateItem',
        )

        svc = _make_service(table)
        from errors.exceptions import ExternalServiceError
        with pytest.raises(ExternalServiceError):
            svc.tag_connection_to_opportunity('user-1', 'cHJvZmlsZQ==', 'opp-1', 'identified')
        assert table.update_item.call_count == 1

    def test_duplicate_tag_validates_without_retry(self):
        """ValidationError inside build_update must not trigger retry."""
        table = MagicMock()
        table.get_item.return_value = {
            'Item': {'opportunities': [{'opportunityId': 'opp-1', 'stage': 'identified'}], 'updatedAt': '2026-01-01'}
        }
        svc = _make_service(table)
        from errors.exceptions import ValidationError
        with pytest.raises(ValidationError):
            svc.tag_connection_to_opportunity('user-1', 'cHJvZmlsZQ==', 'opp-1', 'identified')
        table.update_item.assert_not_called()

    def test_untag_retries_then_raises(self, monkeypatch):
        mod = _service_module()
        monkeypatch.setattr(mod.time, 'sleep', lambda *_: None)

        table = MagicMock()
        table.get_item.return_value = {
            'Item': {'opportunities': [{'opportunityId': 'opp-1', 'stage': 'identified'}], 'updatedAt': '2026-01-01'}
        }
        table.update_item.side_effect = _ccf_error()

        svc = _make_service(table)
        with pytest.raises(mod.OptimisticConcurrencyError):
            svc.untag_connection_from_opportunity('user-1', 'cHJvZmlsZQ==', 'opp-1')
        assert table.update_item.call_count == mod.MAX_RETRIES

    def test_stage_update_retries_then_raises(self, monkeypatch):
        mod = _service_module()
        monkeypatch.setattr(mod.time, 'sleep', lambda *_: None)

        table = MagicMock()
        table.get_item.return_value = {
            'Item': {'opportunities': [{'opportunityId': 'opp-1', 'stage': 'identified'}], 'updatedAt': '2026-01-01'}
        }
        table.update_item.side_effect = _ccf_error()

        svc = _make_service(table)
        with pytest.raises(mod.OptimisticConcurrencyError):
            svc.update_connection_stage('user-1', 'cHJvZmlsZQ==', 'opp-1', 'replied')
        assert table.update_item.call_count == mod.MAX_RETRIES
