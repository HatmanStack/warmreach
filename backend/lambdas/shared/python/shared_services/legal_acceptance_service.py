"""Records which legal documents a user has accepted, and at which version.

LinkedIn's User Agreement restricts automated access to its service, and
LinkedIn restricts and bans accounts it believes are automated — so the risk of
using this product's automation falls on the user's own account. Taking payment
without evidence that the user was told is the exposure this module exists to
close.

Deliberately phrased as risk rather than as a conclusion about whether this use
breaches those terms: that question is reserved for counsel (see
docs/legal/README.md), and a stray assertion in a docstring would undo the
position the published documents take.

Enforcement is server-side deliberately. A modal the client can skip is not a
gate — ``require_automation_acceptance`` is called on the action-dispatch path,
so a client that never renders the disclosure still cannot automate.

Versions are strings, not booleans. When a document changes materially its
version is bumped, every user's acceptance goes stale, and they are asked
again — which is the only way an acceptance record means anything after the
document it refers to has been rewritten.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

#: Document id -> the version currently required.
#:
#: These MUST match the ``Version:`` line in the corresponding file under
#: docs/legal/. If they disagree, this module wins and the mismatch is a bug —
#: a user would be accepting a version string that names a document they were
#: never shown.
REQUIRED_DOCUMENTS: dict[str, str] = {
    'linkedin_risk_disclosure': '2026-07-26.1',
    'terms_of_use': '2026-07-26.1',
    'privacy_policy': '2026-07-26.1',
    'acceptable_use': '2026-07-26.1',
}

#: The document that specifically gates automation. Accepting the terms is not
#: the same as being told your LinkedIn account may be banned, so this one is
#: checked separately on the dispatch path.
AUTOMATION_DOCUMENT = 'linkedin_risk_disclosure'

#: Human-readable titles, for the acknowledgment UI.
DOCUMENT_TITLES: dict[str, str] = {
    'linkedin_risk_disclosure': 'LinkedIn Automation Risk Disclosure',
    'terms_of_use': 'Terms of Use',
    'privacy_policy': 'Privacy Policy',
    'acceptable_use': 'Acceptable Use Policy',
}


class AcceptanceRequiredError(Exception):
    """Raised when an action needs an acknowledgment the user has not given."""

    def __init__(self, document_id: str, version: str):
        super().__init__(f'Acceptance required for {document_id} v{version}')
        self.document_id = document_id
        self.version = version


def _sk(document_id: str) -> str:
    return f'LEGAL#{document_id}'


class LegalAcceptanceService:
    def __init__(self, table):
        self.table = table

    def get_acceptances(self, user_sub: str) -> dict[str, dict[str, Any]]:
        """Return {document_id: {version, acceptedAt}} for this user."""
        try:
            resp = self.table.query(
                KeyConditionExpression='PK = :pk AND begins_with(SK, :sk)',
                ExpressionAttributeValues={':pk': f'USER#{user_sub}', ':sk': 'LEGAL#'},
            )
        except ClientError:
            # Fail closed: an unreadable acceptance record must read as "not
            # accepted", never as "accepted". The user re-acknowledges; the
            # alternative is automating on an assumption.
            logger.exception('Could not read legal acceptances for %s', user_sub)
            return {}

        out: dict[str, dict[str, Any]] = {}
        for item in resp.get('Items', []):
            doc_id = str(item.get('SK', '')).removeprefix('LEGAL#')
            if doc_id:
                out[doc_id] = {
                    'version': item.get('version'),
                    'acceptedAt': item.get('acceptedAt'),
                }
        return out

    def outstanding_documents(self, user_sub: str) -> list[dict[str, str]]:
        """Documents the user has not accepted at the version now required."""
        accepted = self.get_acceptances(user_sub)
        outstanding = []
        for doc_id, required_version in REQUIRED_DOCUMENTS.items():
            if accepted.get(doc_id, {}).get('version') != required_version:
                outstanding.append(
                    {
                        'documentId': doc_id,
                        'title': DOCUMENT_TITLES.get(doc_id, doc_id),
                        'version': required_version,
                    }
                )
        return outstanding

    def has_accepted(self, user_sub: str, document_id: str) -> bool:
        """Whether this user accepted this document at its current version."""
        required = REQUIRED_DOCUMENTS.get(document_id)
        if required is None:
            # An unknown document cannot be satisfied; treat as not accepted
            # rather than silently permitting.
            logger.error('Unknown legal document requested: %r', document_id)
            return False
        return self.get_acceptances(user_sub).get(document_id, {}).get('version') == required

    def record_acceptance(self, user_sub: str, document_ids: list[str]) -> dict[str, Any]:
        """Record acceptance of each document at its currently required version.

        Ignores unknown ids rather than failing the whole call — a client that
        sends a stale document name should not block the user from accepting
        the ones that are real.
        """
        now = datetime.now(UTC).isoformat()
        recorded = []
        for doc_id in document_ids:
            version = REQUIRED_DOCUMENTS.get(doc_id)
            if version is None:
                logger.warning('Ignoring acceptance of unknown document %r', doc_id)
                continue
            self.table.put_item(
                Item={
                    'PK': f'USER#{user_sub}',
                    'SK': _sk(doc_id),
                    'documentId': doc_id,
                    'version': version,
                    'acceptedAt': now,
                }
            )
            recorded.append({'documentId': doc_id, 'version': version})

        # An acceptance is evidence about a past event, so it is also written to
        # the log — which outlives the record if the account is later erased.
        for entry in recorded:
            logger.info(
                'legal_acceptance_recorded',
                extra={
                    'user_id': user_sub,
                    'operation': 'accept_legal_documents',
                    'document_id': entry['documentId'],
                    'document_version': entry['version'],
                },
            )

        return {'recorded': recorded, 'acceptedAt': now, 'outstanding': self.outstanding_documents(user_sub)}


def require_automation_acceptance(table, user_sub: str) -> None:
    """Guard the automation dispatch path.

    :raises AcceptanceRequiredError: when the risk disclosure has not been
        accepted at its current version.
    """
    if not LegalAcceptanceService(table).has_accepted(user_sub, AUTOMATION_DOCUMENT):
        raise AcceptanceRequiredError(AUTOMATION_DOCUMENT, REQUIRED_DOCUMENTS[AUTOMATION_DOCUMENT])
