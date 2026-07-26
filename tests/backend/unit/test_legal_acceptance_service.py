"""Tests for legal document acceptance and the automation gate.

The point of the gate is that it cannot be skipped. Most of these pin the ways
it could be: a stale version silently counting as accepted, a read failure
reading as consent, or the check living only in the UI.
"""

import json
from pathlib import Path

import boto3
import pytest
from moto import mock_aws
from shared_services.legal_acceptance_service import (
    AUTOMATION_DOCUMENT,
    DOCUMENT_TITLES,
    REQUIRED_DOCUMENTS,
    AcceptanceRequiredError,
    LegalAcceptanceService,
    require_automation_acceptance,
)

USER = 'user-legal-1'


@pytest.fixture
def table(aws_credentials):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        yield dynamodb.create_table(
            TableName='legal-test',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )


class TestDocumentRegistry:
    def test_versions_match_the_documents_on_disk(self):
        """A version here that names a document nobody was shown is meaningless."""
        legal_dir = Path(__file__).resolve().parents[3] / 'docs' / 'legal'
        filenames = {
            'linkedin_risk_disclosure': 'LINKEDIN_RISK_DISCLOSURE.md',
            'terms_of_use': 'TERMS_OF_USE.md',
            'privacy_policy': 'PRIVACY_POLICY.md',
            'acceptable_use': 'ACCEPTABLE_USE.md',
        }
        for doc_id, required_version in REQUIRED_DOCUMENTS.items():
            path = legal_dir / filenames[doc_id]
            assert path.exists(), f'{doc_id} has no document at {path}'
            text = path.read_text(encoding='utf-8')
            assert f'`{required_version}`' in text, (
                f'{path.name} does not declare version {required_version}; '
                f'users would accept a version string naming a document they never saw'
            )

    def test_every_required_document_has_a_title(self):
        missing = set(REQUIRED_DOCUMENTS) - set(DOCUMENT_TITLES)
        assert not missing, f'no display title for {sorted(missing)}'

    def test_the_automation_document_is_required(self):
        assert AUTOMATION_DOCUMENT in REQUIRED_DOCUMENTS


class TestAcceptance:
    def test_a_new_user_has_everything_outstanding(self, table):
        outstanding = LegalAcceptanceService(table).outstanding_documents(USER)

        assert {d['documentId'] for d in outstanding} == set(REQUIRED_DOCUMENTS)

    def test_recording_clears_the_outstanding_list(self, table):
        svc = LegalAcceptanceService(table)

        result = svc.record_acceptance(USER, list(REQUIRED_DOCUMENTS))

        assert result['outstanding'] == []
        assert len(result['recorded']) == len(REQUIRED_DOCUMENTS)

    def test_partial_acceptance_leaves_the_rest_outstanding(self, table):
        svc = LegalAcceptanceService(table)

        svc.record_acceptance(USER, [AUTOMATION_DOCUMENT])

        remaining = {d['documentId'] for d in svc.outstanding_documents(USER)}
        assert AUTOMATION_DOCUMENT not in remaining
        assert remaining == set(REQUIRED_DOCUMENTS) - {AUTOMATION_DOCUMENT}

    def test_a_stale_version_does_not_count_as_accepted(self, table):
        """The whole reason versions are strings rather than a boolean."""
        table.put_item(
            Item={
                'PK': f'USER#{USER}',
                'SK': f'LEGAL#{AUTOMATION_DOCUMENT}',
                'documentId': AUTOMATION_DOCUMENT,
                'version': '1999-01-01.1',
                'acceptedAt': '1999-01-01T00:00:00Z',
            }
        )

        assert LegalAcceptanceService(table).has_accepted(USER, AUTOMATION_DOCUMENT) is False

    def test_unknown_documents_are_ignored_not_fatal(self, table):
        svc = LegalAcceptanceService(table)

        result = svc.record_acceptance(USER, ['not_a_real_document', AUTOMATION_DOCUMENT])

        assert [r['documentId'] for r in result['recorded']] == [AUTOMATION_DOCUMENT]

    def test_an_unknown_document_is_never_considered_accepted(self, table):
        assert LegalAcceptanceService(table).has_accepted(USER, 'not_a_real_document') is False

    def test_a_read_failure_reads_as_not_accepted(self, table):
        """Fail closed: an unreadable record must never permit automation."""
        from unittest.mock import MagicMock

        from botocore.exceptions import ClientError

        broken = MagicMock()
        broken.query.side_effect = ClientError({'Error': {'Code': 'ProvisionedThroughputExceeded'}}, 'Query')

        assert LegalAcceptanceService(broken).has_accepted(USER, AUTOMATION_DOCUMENT) is False

    def test_one_users_acceptance_does_not_cover_another(self, table):
        LegalAcceptanceService(table).record_acceptance(USER, list(REQUIRED_DOCUMENTS))

        assert LegalAcceptanceService(table).has_accepted('someone-else', AUTOMATION_DOCUMENT) is False


class TestAutomationGate:
    def test_blocks_a_user_who_has_not_acknowledged(self, table):
        with pytest.raises(AcceptanceRequiredError) as exc:
            require_automation_acceptance(table, USER)

        assert exc.value.document_id == AUTOMATION_DOCUMENT

    def test_allows_a_user_who_has(self, table):
        LegalAcceptanceService(table).record_acceptance(USER, [AUTOMATION_DOCUMENT])

        require_automation_acceptance(table, USER)  # must not raise

    def test_accepting_the_other_documents_is_not_enough(self, table):
        """Agreeing to terms is not being told your account may be banned."""
        others = [d for d in REQUIRED_DOCUMENTS if d != AUTOMATION_DOCUMENT]
        LegalAcceptanceService(table).record_acceptance(USER, others)

        with pytest.raises(AcceptanceRequiredError):
            require_automation_acceptance(table, USER)


class TestActionGateEnforcement:
    """The gate must hold server-side, not only in the UI."""

    @pytest.fixture
    def gate(self, table, monkeypatch):
        from conftest import load_lambda_module

        monkeypatch.setenv('DYNAMODB_TABLE_NAME', table.name)
        module = load_lambda_module('linkedin-action-gate')
        module.table = table
        return module

    def _event(self, action_type='linkedin:add-connection'):
        return {
            'httpMethod': 'POST',
            'requestContext': {
                'http': {'method': 'POST'},
                'authorizer': {'jwt': {'claims': {'sub': USER}}},
            },
            'body': json.dumps({'type': action_type, 'payload': {}}),
        }

    def test_a_client_that_skips_the_modal_still_cannot_automate(self, gate, table):
        resp = gate.lambda_handler(self._event(), None)

        assert resp['statusCode'] == 403
        body = json.loads(resp['body'])
        assert body['code'] == 'LEGAL_ACCEPTANCE_REQUIRED'
        assert body['documentId'] == AUTOMATION_DOCUMENT

    def test_the_response_tells_the_client_what_to_show(self, gate, table):
        """A 403 the client cannot act on just strands the user."""
        body = json.loads(gate.lambda_handler(self._event(), None)['body'])

        assert body['version'] == REQUIRED_DOCUMENTS[AUTOMATION_DOCUMENT]

    def test_the_gate_opens_once_acknowledged(self, gate, table):
        LegalAcceptanceService(table).record_acceptance(USER, [AUTOMATION_DOCUMENT])

        resp = gate.lambda_handler(self._event(), None)

        # Past the legal gate — whatever happens next (quota, dispatch) is not
        # a 403 for acceptance.
        assert not (resp['statusCode'] == 403 and json.loads(resp['body']).get('code') == 'LEGAL_ACCEPTANCE_REQUIRED')
