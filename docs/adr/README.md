# Architecture Decision Records

This directory collects the load-bearing architecture decisions cited in-code across the WarmReach Pro monorepo. Each record follows the Nygard template: `Status`, `Context`, `Decision`, `Consequences`.

When a comment in source code cites `ADR-NNN`, the matching file here is the source of truth for that decision.

## Index

| ADR | Title |
|-----|-------|
| [ADR-001](./ADR-001-ssrf-safe-url-validation.md) | SSRF-safe URL validation (parse-only, no DNS resolution) |
| [ADR-002](./ADR-002-conversion-likelihood-classification.md) | Conversion-likelihood classification rules (HIGH/MEDIUM/LOW) |
| [ADR-003](./ADR-003-ragstack-rate-limit-sleep.md) | RAGStack rate-limit sleep strategy (synchronous `time.sleep` in Lambda) |
| [ADR-004](./ADR-004-ssm-backed-secret-ttl-cache.md) | SSM-backed secret TTL cache (OpenAI API key) |
| [ADR-005](./ADR-005-followup-default-thresholds.md) | Followup default thresholds (min score, max recency, limit) |
| [ADR-006](./ADR-006-jwt-signature-not-verified.md) | JWT signature-not-verified tradeoff (client validates expiration + structure only) |
| [ADR-007](./ADR-007-client-side-filtering-possible-connections.md) | Client-side filtering for non-ingested (possible) connections |
| [ADR-008](./ADR-008-browser-timezone-auto-detection.md) | Browser-side timezone auto-detection and persistence |

## Conventions

1. One decision per ADR. Do not stack multiple decisions in one file.
1. Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-NNN`.
1. The `Context` section quotes the cited source lines verbatim so the decision is traceable back to the code.
1. Replace, do not rewrite: if a decision changes, add a new ADR and mark the old one `Superseded`.
