# Legal documents

> **These are DRAFTS written by the engineering team. None has been reviewed by
> a lawyer. Do not publish them, rely on them, or accept payment on the strength
> of them until qualified counsel has reviewed and revised them.**

## Why these exist

The product had no terms, no privacy policy and no risk disclosure, while
`frontend/src/pages/Auth.tsx` already told users _"By signing up, you agree to
our Terms of Service and Privacy Policy"_ — documents that did not exist. That
is worse than saying nothing, because it asserts an agreement to terms nobody
can read.

Separately, the product automates a user's own LinkedIn account — which
LinkedIn's User Agreement restricts and which LinkedIn enforces against with
bans — and stores LLM-generated inferences about third parties who never
consented. Both need to be disclosed to a user before they pay.

**Note on framing.** These documents deliberately do _not_ assert that WarmReach
breaches LinkedIn's terms. An earlier draft did, which would have put a written
admission against interest into the company's own published documents. The
position taken instead is factual and verifiable: LinkedIn's terms restrict
automated access, LinkedIn enforces with restrictions and bans, and the user's
account is therefore at risk. Whether a member automating their own account
actually breaches those terms is a question for counsel, not for the product's
own terms to concede.

| Document                                                   | Purpose                                      | Acknowledgment gated |
| ---------------------------------------------------------- | -------------------------------------------- | -------------------- |
| [LINKEDIN_RISK_DISCLOSURE.md](LINKEDIN_RISK_DISCLOSURE.md) | What automating LinkedIn actually risks      | **Yes**              |
| [TERMS_OF_USE.md](TERMS_OF_USE.md)                         | The contract with the user                   | Yes                  |
| [PRIVACY_POLICY.md](PRIVACY_POLICY.md)                     | What is collected, why, and who it goes to   | Yes                  |
| [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)                     | What the product may not be used for         | Yes                  |
| [DATA_RETENTION.md](DATA_RETENTION.md)                     | How long data is kept and when it is deleted | No — reference       |

## Versioning

Each document carries a `Version:` line. The acknowledgment gate records which
versions a user accepted and when. Changing a document's version re-prompts
every user on their next visit, so **bump the version whenever the substance
changes** — not for typos.

The versions the application currently requires are listed in
`shared_services/legal_acceptance_service.py`. If a document's `Version:` line
and that module disagree, the module wins and the mismatch is a bug.

## What a lawyer specifically needs to look at

Flagged because engineering judgement is not sufficient on any of these:

1. **Whether the risk disclosure is sufficient** to establish informed consent,
   and whether the liability limitations are enforceable in the jurisdictions
   being sold into.
2. **Whether a member automating their own account** — on their own credentials,
   over data they already have access to — is meaningfully different from
   third-party scraping under LinkedIn's terms and applicable law. Note that
   _hiQ v. LinkedIn_ found scraping public data by a non-logged-in party likely
   did not violate the CFAA, but hiQ still lost on breach of contract; this
   product logs in, which is a different posture again. The answer affects how
   these documents should be worded, but not whether the ban risk needs
   disclosing.
2. **The third-party data position.** The product stores LLM-generated
   inferences about people who never consented. Establishing whether the user,
   WarmReach, or both are controllers under GDPR determines who owes those
   people notice and rights — and the answer changes what the product must
   build next.
3. **Whether a legitimate-interest basis is actually available** for processing
   connection data, or whether something else is required.
4. **Consumer-protection rules on subscriptions** in each market being sold
   into (cancellation, renewal notice, refunds).
5. **Whether the "no refunds for LinkedIn account restriction" position is
   enforceable**, or whether it is void as an unfair term in some jurisdictions.

## Engineering notes

- The acknowledgment gate is enforced server-side, not only in the UI: the
  automation dispatch path checks acceptance, so a client that skips the modal
  still cannot automate.
- Acceptance records are stored per user with document version and timestamp,
  under the `LEGAL#` sort-key prefix.
- **Open question for counsel, and a required follow-up:** account erasure
  (PR #208) currently sweeps the whole `USER#{sub}` partition, which would
  delete these acceptance records along with everything else — removing the only
  proof the disclosure was ever made. Retaining them is arguably necessary for
  establishing consent, but retaining data after an erasure request needs a
  lawful basis. Whichever way that lands, `KNOWN_SK_PREFIXES` and the erasure
  scope must be updated deliberately rather than left to default behaviour.
