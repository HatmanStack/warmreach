"""Integration tests for Quota Service."""

import pytest
from shared_services.quota_service import QuotaService
from errors.exceptions import QuotaExceededError

pytestmark = pytest.mark.integration

class TestQuotaIntegration:
    """Integration tests for QuotaService with Moto DynamoDB."""

    def test_quota_exhaustion_flow(self, dynamodb_table):
        """Test the flow of reporting usage until quota is exhausted."""
        user_id = 'test-user-quota'
        service = QuotaService(dynamodb_table)
        
        # 1. Setup user tier
        dynamodb_table.put_item(Item={
            'PK': f'USER#{user_id}',
            'SK': 'TIER#current',
            'tier': 'pro',
            'quotas': {
                'daily_linkedin_interactions': 5,
                'monthly_linkedin_interactions': 10
            }
        })
        
        # 2. Report usage within limits
        service.report_usage(user_id, 'search', count=3)
        status = service.get_quota_status(user_id, 'search')
        assert status['allowed'] is True
        assert status['remaining'] == 2
        
        # 3. Report usage reaching the limit
        service.report_usage(user_id, 'search', count=2)
        
        # 4. Report usage exceeding the limit
        with pytest.raises(QuotaExceededError) as exc:
            service.report_usage(user_id, 'search', count=1)
        assert 'Daily quota exceeded' in str(exc.value)
        
        # 5. Verify status also reports exceeded
        with pytest.raises(QuotaExceededError):
            service.get_quota_status(user_id, 'search')

    def test_monthly_quota_exhaustion(self, dynamodb_table):
        """Test monthly quota exhaustion independently of daily."""
        user_id = 'test-user-monthly'
        service = QuotaService(dynamodb_table)
        
        dynamodb_table.put_item(Item={
            'PK': f'USER#{user_id}',
            'SK': 'TIER#current',
            'tier': 'free',
            'quotas': {
                'daily_linkedin_interactions': 100,
                'monthly_linkedin_interactions': 5
            }
        })
        
        # Report 5 interactions (monthly limit)
        service.report_usage(user_id, 'search', count=5)
        
        # Next one should fail due to monthly limit
        with pytest.raises(QuotaExceededError) as exc:
            service.report_usage(user_id, 'search', count=1)
        assert 'Monthly quota exceeded' in str(exc.value)

    def test_quota_isolation_between_users(self, dynamodb_table):
        """Test that quota for one user doesn't affect another."""
        user1 = 'user-1'
        user2 = 'user-2'
        service = QuotaService(dynamodb_table)
        
        for uid in [user1, user2]:
            dynamodb_table.put_item(Item={
                'PK': f'USER#{uid}',
                'SK': 'TIER#current',
                'tier': 'pro',
                'quotas': {'daily_linkedin_interactions': 1}
            })
            
        # User 1 exhausts quota
        service.report_usage(user1, 'search', count=1)
        with pytest.raises(QuotaExceededError):
            service.report_usage(user1, 'search', count=1)
            
        # User 2 should still be allowed
        status = service.get_quota_status(user2, 'search')
        assert status['allowed'] is True
        service.report_usage(user2, 'search', count=1)
