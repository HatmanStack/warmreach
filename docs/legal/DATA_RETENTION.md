# Data Retention Policy

> **DRAFT — NOT LEGAL ADVICE.** Not reviewed by a lawyer. See
> [README](README.md).

**Version:** `2026-07-26.1`

## Principle

Keep data while it is doing a job for the user, and delete it when it is not.
The product accumulates information about third parties who never consented, so
open-ended retention is not a neutral default — it is a growing liability.

## Retention by data type

| Data                                             | Retained                      | Mechanism                  |
| ------------------------------------------------ | ----------------------------- | -------------------------- |
| Account, settings, tier                          | Life of the account           | Deleted on account erasure |
| Connection data, notes, tags                     | Life of the account           | Deleted on account erasure |
| LLM inferences (scores, probabilities, rankings) | Life of the account           | Deleted on account erasure |
| Notifications                                    | 30 days                       | DynamoDB TTL               |
| Daily usage counters                             | 90 days                       | DynamoDB TTL               |
| Monthly usage + cost counters                    | 400 days                      | DynamoDB TTL               |
| Deep-research jobs and results                   | Life of the account           | Deleted on account erasure |
| Stripe webhook idempotency records               | 30 days                       | DynamoDB TTL               |
| Legal acceptance records                         | See open question below       | —                          |
| CloudWatch logs                                  | 30 days                       | Log group retention        |
| Stripe billing records                           | As Stripe and tax law require | Held by Stripe             |

## Account erasure

A user can erase their account in the app. That removes everything stored under
their partition, plus the Stripe customer mapping. It is irreversible and
requires explicit confirmation.

## Known gaps

These are recorded because an undocumented gap is indistinguishable from a
policy decision.

**Orphaned third-party profiles.** Imported LinkedIn profile records
(`PROFILE#{id}`) are shared across every account connected to that person, so
they are not deleted when one account is erased — doing so would destroy other
users' data. **Nothing currently removes a profile once the last account
referencing it is gone**, so those records persist indefinitely. A sweep that
deletes unreferenced profiles is required and not yet built. This is the largest
outstanding retention gap and it concerns exactly the third-party data that
carries the most risk.

**Legal acceptance records.** Whether a record that someone accepted the terms
should survive their erasure request is a question for counsel: retaining it is
arguably necessary to evidence consent, but retaining data after an erasure
request needs a lawful basis. Currently unresolved — see
[README](README.md).

**`DeletionPolicy: Retain` on the DynamoDB table.** Deleting the CloudFormation
stack leaves the table, and all data in it, in place. That is deliberate
protection against accidental stack deletion, but it means decommissioning the
service requires a separate, explicit data-destruction step that is not
automated.

**Backups.** AWS point-in-time recovery, if enabled, retains data for its window
regardless of user-initiated deletion. An erasure is therefore not immediately
reflected in backups.

<!-- TODO(counsel): whether the backup window needs disclosing to users, and
     whether a documented restore-then-re-erase procedure is required. -->
