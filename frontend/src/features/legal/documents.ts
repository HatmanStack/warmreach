/**
 * The legal documents, imported from the single copy in `docs/legal/`.
 *
 * `docs/legal/` is the single source of truth. Vite refuses to read files
 * outside the frontend root, so `scripts/sync-legal-docs.mjs` copies them into
 * `./documents/` and `documents.sync.test.ts` fails if the copies drift. Edit
 * `docs/legal/`, never the copies — otherwise users would be shown text that no
 * longer matches the version string they are accepting.
 */

import acceptableUse from './documents/ACCEPTABLE_USE.md?raw';
import dataRetention from './documents/DATA_RETENTION.md?raw';
import riskDisclosure from './documents/LINKEDIN_RISK_DISCLOSURE.md?raw';
import privacyPolicy from './documents/PRIVACY_POLICY.md?raw';
import termsOfUse from './documents/TERMS_OF_USE.md?raw';

/** Document ids, matching `REQUIRED_DOCUMENTS` in legal_acceptance_service.py. */
export type LegalDocumentId =
  | 'linkedin_risk_disclosure'
  | 'terms_of_use'
  | 'privacy_policy'
  | 'acceptable_use';

/**
 * Readable but not acknowledgment-gated.
 *
 * The privacy policy's entire "How long we keep it" section is a pointer to the
 * data retention policy, so a reader who cannot open that document is reading a
 * privacy policy with a hole in it. It is a reference document, not a contract:
 * it is deliberately absent from `REQUIRED_DOCUMENTS`, so nothing here changes
 * what a user is asked to accept.
 */
export type LegalReferenceDocumentId = 'data_retention';

/** Any document the reader can open in the gate — gated or reference. */
export type ReadableDocumentId = LegalDocumentId | LegalReferenceDocumentId;

const RAW: Record<LegalDocumentId, string> = {
  linkedin_risk_disclosure: riskDisclosure,
  terms_of_use: termsOfUse,
  privacy_policy: privacyPolicy,
  acceptable_use: acceptableUse,
};

const REFERENCE_RAW: Record<LegalReferenceDocumentId, string> = {
  data_retention: dataRetention,
};

const ALL_RAW: Record<ReadableDocumentId, string> = { ...RAW, ...REFERENCE_RAW };

/** Titles for the reference documents; the gated ones are titled by the API. */
export const REFERENCE_DOCUMENT_TITLES: Record<LegalReferenceDocumentId, string> = {
  data_retention: 'Data Retention',
};

/**
 * The document body, with the internal drafting banner removed.
 *
 * The `> **DRAFT — NOT LEGAL ADVICE.**` block is a note to ourselves about
 * review status; showing it to a user in an acceptance dialog would undermine
 * the acknowledgment they are being asked to give. It stays in the repository
 * copy, which is what counsel reads.
 */
export function documentBody(id: ReadableDocumentId): string {
  const raw = ALL_RAW[id] ?? '';
  return (
    raw
      // Internal notes-to-self must not reach the renderer at all. HTML comments
      // hold TODOs for counsel (missing addresses, unresolved questions); a
      // markdown renderer usually swallows them, but "usually" is not a property
      // to rely on for text inside a legal acceptance dialog — and the comment
      // bodies contain headings that would render if it ever did.
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('>'))
      .join('\n')
      // Relative links to sibling documents (e.g. DATA_RETENTION.md) have no
      // route in the SPA, so rendering them as links sends the reader to a 404
      // from inside a dialog they cannot dismiss. Keep the text, drop the link.
      .replace(/\[([^\]]+)\]\((?!https?:)[^)]*\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** The `**Version:** \`x\`` declared inside a document, or null if absent. */
export function documentVersion(id: ReadableDocumentId): string | null {
  const match = (ALL_RAW[id] ?? '').match(/\*\*Version:\*\*\s*`([^`]+)`/);
  return match?.[1] ?? null;
}

export const LEGAL_DOCUMENT_IDS = Object.keys(RAW) as LegalDocumentId[];

/** Reference documents, in display order. Never part of an acceptance payload. */
export const REFERENCE_DOCUMENT_IDS = Object.keys(REFERENCE_RAW) as LegalReferenceDocumentId[];

/** Everything the bundle carries, which is everything a reader can be shown. */
export const READABLE_DOCUMENT_IDS: ReadableDocumentId[] = [
  ...LEGAL_DOCUMENT_IDS,
  ...REFERENCE_DOCUMENT_IDS,
];
