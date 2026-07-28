# Privacy Policy

> **DRAFT — NOT LEGAL ADVICE.** Not reviewed by a lawyer. The controller /
> processor analysis in particular needs qualified review before publication —
> see `docs/legal/README.md`.

**Version:** `2026-07-26.1`

This policy covers WarmReach Pro, the hosted service. The community edition is
self-hosted: if you run it yourself, you operate your own infrastructure and
this policy does not apply to you.

## The unusual part, first

WarmReach stores information about **other people** — your LinkedIn connections
— not only about you. That includes their profile details, your message history
with them, and **inferences generated about them by a large language model**:
estimated relationship strength, likelihood of replying, influence ranking
within your network.

Those people are not our customers and have not agreed to this. We hold that
data because you directed us to. **You may have your own legal obligations to
them.** See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

## What we collect

**Account data.** Email address and authentication identifiers, held in AWS
Cognito. Subscription status and Stripe customer identifier if you subscribe.

**Usage data.** Counts of operations you perform, token consumption and
estimated cost per operation, and timestamps. Used for quota enforcement and to
understand what the service costs to run.

**Connection data.** For each LinkedIn connection you import: profile
information from LinkedIn, your message history with them, notes you write,
tags you apply, and derived scores and inferences.

**Content you generate.** Drafted messages, comments, post ideas and research
results.

**Operational logs.** Request identifiers, error traces, and the structured
usage lines described above.

## What we do NOT collect

**Your LinkedIn password never reaches our servers.** It is entered in the
desktop client, encrypted at rest using your operating system's keychain, and
used only on your own machine. The cloud service does not accept, transmit or
store it.

We do not sell personal data. We do not use your data or your connections' data
to train models.

## Who we send data to

| Recipient               | What they receive                                                                       | Why                                                         |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **OpenAI**              | Prompt content: profile details, message history, notes for the operation you requested | To generate messages, ideas, analysis and research          |
| **Amazon Web Services** | All stored data                                                                         | Hosting, database, authentication                           |
| **Stripe**              | Email, payment details                                                                  | Subscription billing — card details go to Stripe, not to us |
| **GitHub**              | Nothing personal                                                                        | Desktop client distribution                                 |

**Data sent to OpenAI includes information about your connections**, because
that is what the AI features operate on. OpenAI's API terms state that data
submitted via the API is not used to train their models, but you should read
their terms directly and decide whether you are comfortable with that.

## Where data is stored

United States (AWS `us-east-1`). If you are in the EEA or UK, your data is
transferred to and stored in the US.

<!-- TODO(counsel): the lawful transfer mechanism (SCCs / adequacy) needs to be
     established and named here before selling into the EEA or UK. -->

## How long we keep it

See the [Data Retention Policy](DATA_RETENTION.md), which is shown alongside
this one and lists every category with its retention period.

## Your rights

Whoever you are and wherever you are, you can:

- **Export everything we hold about you** — in the app, or by request
- **Delete your account and its data** — in the app, or by request, subject to
  the exceptions below
- **Ask what we hold and why** — by request

### What deletion does not reach

Stating this plainly because a deletion promise with silent exceptions is worse
than a narrower one kept honestly. Deleting your account removes everything
stored under your account, plus your Stripe customer mapping. It does **not**
remove:

- **Profile records shared with other users.** Imported LinkedIn profile records
  are shared across every account connected to that person; deleting them with
  your account would destroy other users' data. They contain nothing about you.
- **Billing records.** Stripe retains transaction records for its own legal and
  tax obligations. We do not control that retention.
- **Operational logs**, which age out on their own schedule (30 days) rather
  than on request.
- **Backups.** Point-in-time recovery, where enabled, retains data for its
  window, so a deletion is not immediately reflected in backups.
- **Records that you accepted these terms.** Whether these should survive an
  erasure request is currently unresolved — see the
  [Data Retention Policy](DATA_RETENTION.md).

Full detail is in the [Data Retention Policy](DATA_RETENTION.md).

Depending on where you live you may have further rights under the GDPR, UK
GDPR, or CCPA/CPRA, including correction, restriction of processing, objection
to processing, and the right not to be discriminated against for exercising
them. We honour these regardless of whether they apply to you by law.

**We do not sell personal information** as CCPA defines it.

### If you are one of our users' connections

If a WarmReach user holds data about you and you want it removed, the fastest
route is to ask that person directly — they control it and can delete it in the
app. If you cannot identify them or they will not act, contact us and we will
help, though we may need information from you to locate the records.

<!-- TODO(before publication): a real, monitored privacy contact address, and a
     documented internal process for handling a non-user's request. -->

## Automated decision-making

WarmReach generates scores and rankings about your connections and recommends
who to contact. **These are suggestions, not decisions.** Nothing is sent, and
no action is taken on your behalf, without your instruction. No legal or
similarly significant effect is produced automatically.

## Security

- LinkedIn credentials are encrypted at rest on your own device using the OS
  keychain, and never transmitted to us
- Data in transit is encrypted with TLS
- API access requires authentication; each account can only reach its own data
- Secrets are held in AWS SSM and not in source control

No system is perfectly secure, and we do not claim otherwise.

## Changes

We will bump the version on this document and ask you to re-acknowledge it when
the substance changes.

## Contact

<!-- TODO(before publication): controller identity, registered address, and a
     monitored contact address. Required content under GDPR Art. 13. -->
