# Architecture Decision Records

This directory collects the load-bearing architecture decisions cited in-code across the WarmReach Pro monorepo. Each record follows the Nygard template: `Status`, `Context`, `Decision`, `Consequences`.

When a comment in source code cites an ADR, it uses the **three-digit `ADR-NNN` form**, and the matching file in this directory is the source of truth for that decision. Short forms such as `ADR-4` are not citations — they are ambiguous, and the ambiguity was real: for a period `ADR-1`, `ADR-4`, `ADR-7`, and `ADR-10` in production code meant the decision logs of two separate feature plans, so they resolved to unrelated records here, or to nothing.

A decision cited from code must have a record **here**. Plan documents under `docs/plans/` are working notes; they are excluded from the community edition sync, and some were never committed to this repository at all, so a citation pointing into one is a dead reference for at least half the readers. `scripts/check-doc-tables.py` fails when a code comment cites an `ADR-NNN` with no matching file in this directory.

A second, letter-suffixed marker set (`ADR-A` … `ADR-F`) from the 2026-04-23 audit plan survives in thirteen comments across `backend/`, `client/`, and `tests/`, plus one overlay copy. It is **not** this directory's namespace and resolves to nothing here; the decisions it names are recorded in that plan's `Phase-0.md`. Retiring it is deferred — three of the citing files (`backend/template.yaml`, `tests/backend/unit/test_llm.py`, `tests/backend/unit/test_llm_service.py`) are overlay sources whose overlays do not carry the same comment, so renumbering them would mean cosmetic overlay edits for no community-visible gain. The parity checker rejects any _new_ short numeric form, which is the class that actually collided.

This directory syncs verbatim to the community edition, so a decision recorded here is published in both. That is deliberate — it is what makes a citation in a verbatim-synced source file resolve for a community reader — but it means an ADR is the wrong place for a commercial detail that should not ship.

## Index

| ADR                                                                    | Title                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [ADR-001](./ADR-001-ssrf-safe-url-validation.md)                       | SSRF-safe URL validation (parse-only, no DNS resolution)                                           |
| [ADR-002](./ADR-002-conversion-likelihood-classification.md)           | Conversion-likelihood classification rules (HIGH/MEDIUM/LOW)                                       |
| [ADR-003](./ADR-003-ragstack-rate-limit-sleep.md)                      | RAGStack rate-limit sleep strategy (synchronous `time.sleep` in Lambda)                            |
| [ADR-004](./ADR-004-ssm-backed-secret-ttl-cache.md)                    | SSM-backed secret TTL cache (OpenAI API key)                                                       |
| [ADR-005](./ADR-005-followup-default-thresholds.md)                    | Followup default thresholds (min score, max recency, limit)                                        |
| [ADR-006](./ADR-006-jwt-signature-not-verified.md)                     | JWT signature-not-verified tradeoff (client validates expiration + structure only)                 |
| [ADR-007](./ADR-007-client-side-filtering-possible-connections.md)     | Client-side filtering for non-ingested (possible) connections                                      |
| [ADR-008](./ADR-008-browser-timezone-auto-detection.md)                | Browser-side timezone auto-detection and persistence                                               |
| [ADR-009](./ADR-009-command-dispatch-community-clean-boundary.md)      | Command-dispatch community-clean boundary (agent/quota-agnostic core, quota reserved in the gates) |
| [ADR-010](./ADR-010-private-per-user-adjacency-store.md)               | Private per-user contact-to-contact adjacency store (`ADJ#` dual-write rows, no new index)         |
| [ADR-011](./ADR-011-single-tenant-warm-intro-pathfinding.md)           | Warm-intro pathfinding traverses the requester's own graph                                         |
| [ADR-012](./ADR-012-warm-intro-path-scoring-and-display-sourcing.md)   | Warm-intro path scoring and display fields are sourced from where they are written                 |
| [ADR-013](./ADR-013-mutual-connection-collection-consent.md)           | Mutual-connection collection is consent-gated, opt-in and default off                              |
| [ADR-014](./ADR-014-mutual-collection-piggybacks-on-profile-scrape.md) | Mutual collection piggybacks on the existing profile scrape and its pacing                         |
| [ADR-015](./ADR-015-mutual-collection-sync-posture.md)                 | Mutual-collection sync posture (public collector, private data and persistence)                    |
| [ADR-016](./ADR-016-action-items-are-the-durable-source-of-truth.md)   | `ACTION#` items are the durable source of truth; Step Functions drives transitions over them       |
| [ADR-017](./ADR-017-action-queries-overload-gsi1.md)                   | `ACTION#` access patterns overload GSI1; no new index                                              |
| [ADR-018](./ADR-018-out-of-band-confirmation.md)                       | Confirmation is out-of-band; dependent actions are confirmation-gated                              |
| [ADR-019](./ADR-019-li-actions-quota-bucket.md)                        | Real LinkedIn actions meter against a distinct `li-actions` bucket                                 |
| [ADR-020](./ADR-020-approve-before-send-default.md)                    | Approve-before-send is the default; autonomy is opt-in per opportunity and per action type         |
| [ADR-021](./ADR-021-server-side-guardrails-in-one-atomic-gate.md)      | Every operational guardrail is enforced server-side in one atomic gate-and-dispatch task           |
| [ADR-022](./ADR-022-planner-model-is-env-configurable.md)              | The planner model is configurable via environment                                                  |
| [ADR-023](./ADR-023-pro-agent-logic-stays-out-of-verbatim-files.md)    | Pro agent logic stays out of community-verbatim files                                              |
| [ADR-024](./ADR-024-agent-config-lives-on-agentcfg-items.md)           | Agent configuration lives on `AGENTCFG#` items, not on the shared `#SETTINGS` item                 |
| [ADR-025](./ADR-025-warm-path-targeting-consumes-the-mesh.md)          | Warm-path targeting consumes the adjacency mesh; the agent never re-implements it                  |

## Conventions

1. One decision per ADR. Do not stack multiple decisions in one file.
1. Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-NNN`.
1. The `Context` section quotes the cited source lines verbatim so the decision is traceable back to the code.
1. Replace, do not rewrite: if a decision changes, add a new ADR and mark the old one `Superseded`.
1. Cite the long form. `ADR-004`, never `ADR-4`.
