"""Tests for BillingService (ported from warmreach-cp, USER# key pattern)."""

import os

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'


@pytest.fixture
def billing_table(aws_credentials):
    with mock_aws():
        import boto3
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'GSI1',
                    'KeySchema': [
                        {'AttributeName': 'GSI1PK', 'KeyType': 'HASH'},
                        {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'},
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
                }
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )
        yield table


class TestCheckoutCompleted:
    def test_creates_mapping_and_upgrades(self, billing_table):
        from shared_services.billing_service import BillingService
        svc = BillingService(billing_table)

        session = {
            'customer': 'cus_test123',
            'metadata': {'cognitoSub': 'user-abc'},
        }
        svc.handle_checkout_completed(session)

        # Verify STRIPE mapping
        mapping = billing_table.get_item(
            Key={'PK': 'STRIPE#cus_test123', 'SK': '#MAPPING'}
        ).get('Item')
        assert mapping is not None
        assert mapping['cognitoSub'] == 'user-abc'

        # Verify tier upgraded to paid
        tier = billing_table.get_item(
            Key={'PK': 'USER#user-abc', 'SK': 'TIER#current'}
        ).get('Item')
        assert tier['tier'] == 'paid'
        assert tier['quotas']['daily_linkedin_interactions'] == 200

    def test_missing_cognito_sub_raises(self, billing_table):
        from shared_services.billing_service import BillingService
        svc = BillingService(billing_table)

        with pytest.raises(Exception, match='cognitoSub'):
            svc.handle_checkout_completed({'customer': 'cus_test', 'metadata': {}})


class TestSubscriptionUpdated:
    def test_active_keeps_paid(self, billing_table):
        from shared_services.billing_service import BillingService
        svc = BillingService(billing_table)

        # Setup mapping
        billing_table.put_item(Item={
            'PK': 'STRIPE#cus_1',
            'SK': '#MAPPING',
            'cognitoSub': 'user-1',
        })

        svc.handle_subscription_updated({'customer': 'cus_1', 'status': 'active'})

        tier = billing_table.get_item(
            Key={'PK': 'USER#user-1', 'SK': 'TIER#current'}
        ).get('Item')
        assert tier['tier'] == 'paid'

    def test_canceled_downgrades(self, billing_table):
        from shared_services.billing_service import BillingService
        svc = BillingService(billing_table)

        billing_table.put_item(Item={
            'PK': 'STRIPE#cus_1',
            'SK': '#MAPPING',
            'cognitoSub': 'user-1',
        })

        svc.handle_subscription_updated({'customer': 'cus_1', 'status': 'canceled'})

        tier = billing_table.get_item(
            Key={'PK': 'USER#user-1', 'SK': 'TIER#current'}
        ).get('Item')
        assert tier['tier'] == 'free'


class TestSubscriptionDeleted:
    def test_downgrades_to_free(self, billing_table):
        from shared_services.billing_service import BillingService
        svc = BillingService(billing_table)

        billing_table.put_item(Item={
            'PK': 'STRIPE#cus_1',
            'SK': '#MAPPING',
            'cognitoSub': 'user-1',
        })

        svc.handle_subscription_deleted({'customer': 'cus_1'})

        tier = billing_table.get_item(
            Key={'PK': 'USER#user-1', 'SK': 'TIER#current'}
        ).get('Item')
        assert tier['tier'] == 'free'
