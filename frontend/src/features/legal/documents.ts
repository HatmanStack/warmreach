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
import riskDisclosure from './documents/LINKEDIN_RISK_DISCLOSURE.md?raw';
import privacyPolicy from './documents/PRIVACY_POLICY.md?raw';
import termsOfUse from './documents/TERMS_OF_USE.md?raw';

/** Document ids, matching `REQUIRED_DOCUMENTS` in legal_acceptance_service.py. */
export type LegalDocumentId =
  | 'linkedin_risk_disclosure'
  | 'terms_of_use'
  | 'privacy_policy'
  | 'acceptable_use';

const RAW: Record<LegalDocumentId, string> = {
  linkedin_risk_disclosure: riskDisclosure,
  terms_of_use: termsOfUse,
  privacy_policy: privacyPolicy,
  acceptable_use: acceptableUse,
};

/**
 * The document body, with the internal drafting banner removed.
 *
 * The `> **DRAFT — NOT LEGAL ADVICE.**` block is a note to ourselves about
 * review status; showing it to a user in an acceptance dialog would undermine
 * the acknowledgment they are being asked to give. It stays in the repository
 * copy, which is what counsel reads.
 */
export function documentBody(id: LegalDocumentId): string {
  const raw = RAW[id] ?? '';
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
export function documentVersion(id: LegalDocumentId): string | null {
  const match = (RAW[id] ?? '').match(/\*\*Version:\*\*\s*`([^`]+)`/);
  return match?.[1] ?? null;
}

export const LEGAL_DOCUMENT_IDS = Object.keys(RAW) as LegalDocumentId[];
